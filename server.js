const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('url');
const { exec } = require('child_process');
const os = require('os');
const events = require('events');

// Increase default max listeners to prevent warnings during large uploads
events.defaultMaxListeners = 30;

// Create temp directory for chunk uploads
const TEMP_DIR = path.join(os.tmpdir(), 'file-server-chunks');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Track uploads in memory to improve performance
const uploadTracker = new Map();

// Constants for performance tuning
const HIGH_WATER_MARK = 8 * 1024 * 1024; // Increase to 8MB buffer for write streams
const WRITE_STREAM_OPTIONS = {
  highWaterMark: HIGH_WATER_MARK,
  flags: 'w'
};

// Performance settings
const LOW_WATER_MARK = 4 * 1024 * 1024; // Increase to 4MB threshold
const UPLOAD_TIMEOUT = 48 * 60 * 60 * 1000; // Increase to 48 hours timeout for very large uploads
const SOCKET_TIMEOUT = 10 * 60 * 1000; // 10 minute socket timeout

const server = http.createServer((req, res) => {
  // Increase socket timeout for uploads
  req.socket.setTimeout(SOCKET_TIMEOUT);
  
  // Set CORS headers for cross-tab uploads
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Path, Content-Disposition, Content-Range, X-File-Id');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const { pathname, query } = parse(req.url, true);
  
  // Root endpoint - serve index.html
  if (req.method === 'GET' && pathname === '/') {
    fs.readFile('./public/index.html', (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading HTML');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
  
  // List drives endpoint (Windows only)
  else if (req.method === 'GET' && pathname === '/list-drives') {
    if (process.platform === 'win32') {
      exec('wmic logicaldisk get name', (error, stdout) => {
        if (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: error.message }));
        }
        
        // Parse the output to get drive letters
        const drives = stdout.split('\r\r\n')
          .map(line => line.trim())
          .filter(line => /^[A-Za-z]:$/.test(line))
          .map(drive => drive + '\\');
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ drives }));
      });
    } else {
      // For non-Windows systems, just return root
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ drives: ['/'] }));
    }
  }
  
  // List folders endpoint
  else if (req.method === 'GET' && pathname === '/list-folders') {
    let currentPath = query.path || '/';
    
    // If we're at the root on Windows, redirect to the drive list
    if ((currentPath === '/' || currentPath === '\\') && process.platform === 'win32') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        path: '/', 
        folders: [],
        isRoot: true
      }));
    }
    
    try {
      currentPath = path.resolve(currentPath); // clean path
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      const folders = entries
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: currentPath, folders }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        path: '/', 
        folders: [], 
        error: err.message,
        success: false
      }));
    }
  }
  
  // New endpoint for chunk uploads
  else if (req.method === 'POST' && pathname === '/upload-chunk') {
    try {
      // Set CORS headers for chunked uploads
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Path, Content-Disposition, Content-Range, X-File-Id');
      
      // Extract metadata from headers
      const fileName = decodeURIComponent(req.headers['x-file-name'] || '');
      const chunkIndex = parseInt(req.headers['x-chunk-index'] || '0', 10);
      const totalChunks = parseInt(req.headers['x-total-chunks'] || '1', 10);
      const fileId = req.headers['x-file-id'] || Date.now().toString();
      const targetPath = query.path || getCurrentPath();
      
      // Verify file name
      if (!fileName) {
        console.error('Missing file name');
        return sendErrorResponse(res, 400, 'Missing file name');
      }

      // Create upload directory if it doesn't exist
      const uploadDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      
      // Use the temp directory for chunks
      const tempDir = path.join(os.tmpdir(), 'file-server-chunks', fileId);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Temporary chunk file path
      const chunkPath = path.join(tempDir, `chunk-${chunkIndex}`);
      
      // If first chunk, initialize the upload tracker
      if (chunkIndex === 0) {
        // Create target directory if it doesn't exist
        const outputDir = path.resolve(targetPath);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const finalFilePath = path.join(outputDir, fileName);
        
        // Initialize the write stream with high performance settings
        uploadTracker.set(fileId, {
          finalPath: finalFilePath,
          receivedChunks: new Set(),
          writeStream: fs.createWriteStream(finalFilePath, { 
            highWaterMark: HIGH_WATER_MARK,
            lowWaterMark: LOW_WATER_MARK,
            flags: 'w',
            autoClose: false
          }),
          totalChunks: totalChunks,
          createdAt: Date.now(),
          // Set a longer timeout for uploads to allow background tab uploads
          timeout: setTimeout(() => {
            const upload = uploadTracker.get(fileId);
            if (upload && upload.writeStream) {
              upload.writeStream.end();
              console.log(`Upload timeout for ${fileId}`);
            }
            uploadTracker.delete(fileId);
          }, UPLOAD_TIMEOUT)
        });
        
        console.log(`New upload started: ${fileName} (${fileId})`);
        
        // Respond immediately for the first chunk to avoid client waiting
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Upload session initialized',
          fileId: fileId
        }));
        
        // Process the data after response has been sent
        req.on('data', (chunk) => {
          // Process data chunks as they come
          const upload = uploadTracker.get(fileId);
          if (upload && upload.writeStream) {
            upload.writeStream.write(chunk);
          }
        });
        
        // Store reference to the socket close handler to properly clean it up
        const socketCloseHandler = () => {
          console.log(`Client disconnected during first chunk upload of ${fileId}`);
          
          // Clean up if we haven't finished writing
          const upload = uploadTracker.get(fileId);
          if (upload && !upload.receivedChunks.has(0)) {
            clearTimeout(upload.timeout);
            uploadTracker.delete(fileId);
          }
        };
        
        // Add handler for client disconnection
        req.socket.on('close', socketCloseHandler);
        
        req.on('end', () => {
          const upload = uploadTracker.get(fileId);
          if (upload) {
            upload.receivedChunks.add(chunkIndex);
            console.log(`Chunk ${chunkIndex} processed for ${fileId}`);
          }
          
          // Remove the socket close handler to prevent memory leaks
          req.socket.removeListener('close', socketCloseHandler);
        });
        
        // Early return since we've already sent the response
        return;
      }
      
      // Get the upload tracker for this file
      const upload = uploadTracker.get(fileId);
      if (!upload) {
        // If the tracker is missing but we're on chunk 0, create it
        if (chunkIndex === 0) {
          // Reinitialize the tracker
          const outputDir = path.resolve(targetPath);
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          
          const finalFilePath = path.join(outputDir, fileName);
          
          // Initialize the write stream with high performance settings
          uploadTracker.set(fileId, {
            finalPath: finalFilePath,
            receivedChunks: new Set(),
            writeStream: fs.createWriteStream(finalFilePath, { 
              highWaterMark: HIGH_WATER_MARK,
              lowWaterMark: LOW_WATER_MARK,
              flags: 'w',
              autoClose: false
            }),
            totalChunks: totalChunks,
            createdAt: Date.now(),
            timeout: setTimeout(() => {
              const upload = uploadTracker.get(fileId);
              if (upload && upload.writeStream) {
                upload.writeStream.end();
              }
              uploadTracker.delete(fileId);
            }, UPLOAD_TIMEOUT)
          });
          
          console.log(`Reinitialized upload: ${fileName} (${fileId})`);
        } else {
          return sendErrorResponse(
            res, 
            400, 
            'Upload session not found. The upload may have expired or the first chunk was not received.', 
            { chunkIndex, fileId },
            'SESSION_NOT_FOUND'
          );
        }
      }
      
      // Check if this chunk was already received (handle retries)
      if (upload.receivedChunks.has(chunkIndex)) {
        res.writeHead(200);
        return res.end(JSON.stringify({ 
          success: true, 
          message: `Chunk ${chunkIndex + 1}/${totalChunks} already received`
        }));
      }
      
      // Pipe the data directly from request to file stream
      let dataBuffer = Buffer.alloc(0);
      
      // Collect all chunk data first
      req.on('data', (chunk) => {
        dataBuffer = Buffer.concat([dataBuffer, chunk]);
      });
      
      // Track when the chunk is done
      req.on('end', async () => {
        try {
          // Write data to the file with backpressure handling
          const canContinue = upload.writeStream.write(dataBuffer);
          
          // Handle backpressure if needed
          if (!canContinue) {
            // Wait for drain event before proceeding
            await new Promise(resolve => upload.writeStream.once('drain', resolve));
          }
          
          // Clear buffer
          dataBuffer = null;
          
          // Mark this chunk as received
          upload.receivedChunks.add(chunkIndex);
          
          // Check if all chunks have been received
          if (upload.receivedChunks.size === upload.totalChunks) {
            // Close the file stream but wait for 'finish' event
            console.log(`File upload almost complete: ${fileName} (${fileId}), finalizing at: ${upload.finalPath}`);
            
            // End the write stream but wait for it to finish before cleaning up
            upload.writeStream.end();
            upload.writeStream.on('finish', () => {
              console.log(`File write stream finished: ${fileName} (${fileId}) at ${upload.finalPath}`);
              console.log(`File exists check: ${fs.existsSync(upload.finalPath)}`);
              console.log(`File size: ${fs.existsSync(upload.finalPath) ? fs.statSync(upload.finalPath).size : 'N/A'} bytes`);
              
              // Clean up only after we're sure the file is written
              clearTimeout(upload.timeout);
              uploadTracker.delete(fileId);
              
              // Clean up temp directory
              try {
                removeDirectory(tempDir);
                console.log(`Cleaned up temporary directory: ${tempDir}`);
              } catch (cleanupError) {
                console.error('Error cleaning up temp files:', cleanupError);
              }
            });
            
            // Send success response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              message: 'File upload complete',
              filePath: upload.finalPath
            }));
          } else {
            // More chunks expected
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              message: `Chunk ${chunkIndex + 1}/${totalChunks} received`,
              received: upload.receivedChunks.size,
              fileId: fileId
            }));
          }
        } catch (error) {
          console.error('Error in chunk upload:', error);
          sendErrorResponse(
            res, 
            500, 
            `Server error during upload: ${error.message || 'Unknown error'}`, 
            error.stack,
            error.code
          );
        }
      });
      
      // Error handling for chunk endpoint
      req.on('error', (error) => {
        console.error(`Chunk upload error for ${fileId}, chunk ${chunkIndex}:`, error);
        
        // For connection reset errors, just log and keep the upload tracker active
        if (error.code === 'ECONNRESET') {
          console.log(`Connection reset detected for ${fileId}, chunk ${chunkIndex}. Upload can be resumed.`);
          
          // Don't consider the chunk complete if the connection was reset
          // The client should retry this chunk
          
          // If this is the first chunk and we haven't finished, clean up
          if (chunkIndex === 0 && !upload.receivedChunks.has(0)) {
            clearTimeout(upload.timeout);
            uploadTracker.delete(fileId);
          }
        } else {
          // For other errors, send response if possible
          try {
            if (!res.headersSent) {
              sendErrorResponse(
                res,
                500,
                `Error uploading chunk: ${error.code || error.message || 'Unknown error'}`,
                error.message,
                error.code
              );
            }
          } catch (responseError) {
            console.error('Could not send error response:', responseError);
          }
        }
      });
      
      // Store reference to the socket close handler to properly clean it up
      const socketCloseHandler = () => {
        if (!res.headersSent) {
          console.log(`Client disconnected during upload of ${fileId}, chunk ${chunkIndex}`);
          
          // If this is the first chunk and we haven't finished writing it, clean up
          if (chunkIndex === 0 && !upload.receivedChunks.has(0)) {
            clearTimeout(upload.timeout);
            uploadTracker.delete(fileId);
          }
        }
      };
      
      // Handle unexpected client disconnections with better error reporting
      req.socket.on('close', socketCloseHandler);
      
      // Clean up the listener when the request completes
      req.on('end', () => {
        // Remove the socket close handler to prevent memory leaks
        req.socket.removeListener('close', socketCloseHandler);
      });
    } catch (error) {
      console.error('Error in chunk upload:', error);
      sendErrorResponse(
        res, 
        500, 
        `Server error during upload initialization: ${error.message || 'Unknown error'}`, 
        error.stack,
        error.code
      );
    }
  }
  
  // Traditional file upload endpoint
  else if (req.method === 'POST' && pathname === '/upload') {
    const contentType = req.headers['content-type'];
    
    if (!contentType || !contentType.includes('multipart/form-data')) {
      res.writeHead(400);
      return res.end(JSON.stringify({
        success: false,
        error: 'Invalid content type, expected multipart/form-data'
      }));
    }
    
    const boundary = contentType.split('boundary=')[1];
    let body = Buffer.alloc(0);

    req.on('data', chunk => body = Buffer.concat([body, chunk]));

    req.on('end', () => {
      try {
        const parts = body.toString().split('--' + boundary);
        let fileBuffer, fileName, destPath;
  
        parts.forEach(part => {
          if (part.includes('name="file"')) {
            const matches = part.match(/filename="(.+?)"/);
            if (matches) {
              fileName = matches[1];
              const start = part.indexOf('\r\n\r\n') + 4;
              const content = part.slice(start, part.lastIndexOf('\r\n'));
              fileBuffer = Buffer.from(content, 'binary');
            }
          }
          if (part.includes('name="targetPath"')) {
            const start = part.indexOf('\r\n\r\n') + 4;
            destPath = part.slice(start, part.lastIndexOf('\r\n')).trim();
          }
        });
  
        if (!fileBuffer || !fileName || !destPath) {
          res.writeHead(400);
          return res.end(JSON.stringify({
            success: false,
            error: 'Missing required fields'
          }));
        }
  
        // Create upload directory if it doesn't exist
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath, { recursive: true });
        }
  
        const fullPath = path.join(destPath, fileName);
        
        // Use write stream with performance optimizations
        const writeStream = fs.createWriteStream(fullPath, WRITE_STREAM_OPTIONS);
        
        writeStream.on('error', (err) => {
          console.error('Error writing file:', err);
          res.writeHead(500);
          res.end(JSON.stringify({
            success: false,
            error: 'Failed to save file: ' + err.message
          }));
        });
        
        writeStream.on('finish', () => {
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            message: 'File uploaded successfully',
            filePath: fullPath
          }));
        });
        
        // Write the buffer to the stream
        writeStream.write(fileBuffer);
        writeStream.end();
      } catch (error) {
        console.error('Error processing upload:', error);
        res.writeHead(500);
        res.end(JSON.stringify({
          success: false,
          error: 'Server error: ' + error.message
        }));
      }
    });
  }
  
  // New endpoint for chunked upload that combines all chunks into final file
  else if (req.method === 'POST' && pathname === '/combine-chunks') {
    // Extract metadata from headers or query parameters
    const fileName = req.headers['x-file-name'] || '';
    const fileId = req.headers['x-file-id'] || '';
    const totalChunks = parseInt(req.headers['x-total-chunks'] || '0', 10);
    const targetPath = query.path || getCurrentPath();
    
    if (!fileName || !fileId || totalChunks === 0) {
      res.writeHead(400);
      return res.end(JSON.stringify({ 
        success: false, 
        error: 'Missing file information' 
      }));
    }
    
    // Check if all chunks exist
    const tempDir = path.join(os.tmpdir(), 'file-server-chunks', fileId);
    if (!fs.existsSync(tempDir)) {
      res.writeHead(404);
      return res.end(JSON.stringify({ 
        success: false, 
        error: 'Upload session not found' 
      }));
    }
    
    // Verify all chunks exist
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(tempDir, `chunk-${i}`);
      if (!fs.existsSync(chunkPath)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ 
          success: false, 
          error: `Missing chunk ${i}` 
        }));
      }
    }
    
    // Create output directory if it doesn't exist
    const outputDir = path.resolve(targetPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Path for final file
    const finalPath = path.join(outputDir, fileName);
    
    // Create write stream for final file
    const outputStream = fs.createWriteStream(finalPath, WRITE_STREAM_OPTIONS);
    
    // Set up error handler
    outputStream.on('error', (err) => {
      console.error('Error writing final file:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ 
        success: false, 
        error: 'Failed to write output file' 
      }));
    });
    
    // Combine all chunks
    combineChunks(tempDir, totalChunks, outputStream)
      .then(() => {
        // Clean up temp directory
        try {
          removeDirectory(tempDir);
        } catch (cleanupError) {
          console.error('Error cleaning up temp files:', cleanupError);
        }
        
        // Send success response
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          message: 'File assembled successfully',
          filePath: finalPath
        }));
      })
      .catch((error) => {
        console.error('Error combining chunks:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Failed to combine chunks' 
        }));
      });
  }
  
  // New endpoint to check if an upload is recoverable
  else if (req.method === 'GET' && pathname === '/check-upload') {
    const fileId = query.fileId;
    
    if (!fileId) {
      res.writeHead(400);
      return res.end(JSON.stringify({ 
        success: false, 
        error: 'Missing fileId parameter' 
      }));
    }
    
    // Check if we have this upload in our tracker
    const upload = uploadTracker.get(fileId);
    if (upload) {
      // Upload session exists
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        exists: true,
        receivedChunks: Array.from(upload.receivedChunks),
        totalChunks: upload.totalChunks,
        fileName: path.basename(upload.finalPath)
      }));
    } else {
      // Check if we have a temp directory for this upload
      const tempDir = path.join(os.tmpdir(), 'file-server-chunks', fileId);
      if (fs.existsSync(tempDir)) {
        try {
          // Count how many chunks we have
          const files = fs.readdirSync(tempDir);
          const chunkFiles = files.filter(file => file.startsWith('chunk-'));
          
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            exists: true,
            tempOnly: true,
            chunkCount: chunkFiles.length
          }));
        } catch (error) {
          res.writeHead(500);
          res.end(JSON.stringify({
            success: false,
            error: 'Error reading temp directory'
          }));
        }
      } else {
        // Upload doesn't exist
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          exists: false
        }));
      }
    }
  }
  
  // Serve static files from the public directory
  else if (req.method === 'GET') {
    let filePath = '.' + pathname;
    if (filePath === './') {
      filePath = './public/index.html';
    } else if (!filePath.startsWith('./public/')) {
      filePath = './public' + pathname;
    }
    
    const extname = path.extname(filePath);
    let contentType = 'text/html';
    
    switch (extname) {
      case '.js':
        contentType = 'text/javascript';
        break;
      case '.css':
        contentType = 'text/css';
        break;
      case '.json':
        contentType = 'application/json';
        break;
      case '.png':
        contentType = 'image/png';
        break;
      case '.jpg':
        contentType = 'image/jpg';
        break;
      case '.svg':
        contentType = 'image/svg+xml';
        break;
    }
    
    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('File not found');
        } else {
          res.writeHead(500);
          res.end(`Server error: ${err.message}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      }
    });
  }
  
  // 404 Not Found for any other requests
  else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Clean up upload tracker on server shutdown
process.on('SIGINT', () => {
  for (const [fileId, upload] of uploadTracker.entries()) {
    if (upload.writeStream) {
      upload.writeStream.end();
    }
    clearTimeout(upload.timeout);
  }
  uploadTracker.clear();
  process.exit(0);
});

// Periodically clean up stale uploads (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [fileId, upload] of uploadTracker.entries()) {
    // If upload is older than 24 hours and not completed
    if (now - upload.createdAt > UPLOAD_TIMEOUT) {
      console.log(`Cleaning up stale upload: ${fileId}`);
      if (upload.writeStream) {
        upload.writeStream.end();
      }
      clearTimeout(upload.timeout);
      uploadTracker.delete(fileId);
    }
  }
}, 60 * 60 * 1000);

// Helper function to get current path
function getCurrentPath() {
  // Always use the base path where the server is running
  // This ensures files are saved in a predictable location
  const basePath = process.cwd();
  
  // Default to an 'uploads' folder within the server directory for better organization
  const uploadPath = path.join(basePath, 'uploads');
  
  // Ensure the path exists
  if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
  }
  
  console.log(`Current upload path: ${uploadPath}`);
  return uploadPath;
}

// Helper function to recursively remove directory using only fs module
function removeDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file) => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        // Recursive case: it's a directory
        removeDirectory(curPath);
      } else {
        // Base case: it's a file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}

// Combined with better stream handling for large files
function combineChunks(chunkDir, totalChunks, outputStream) {
  return new Promise((resolve, reject) => {
    let currentChunk = 0;
    
    function processNextChunk() {
      if (currentChunk >= totalChunks) {
        // All chunks processed
        outputStream.end();
        resolve();
        return;
      }
      
      const chunkPath = path.join(chunkDir, `chunk-${currentChunk}`);
      const readStream = fs.createReadStream(chunkPath, { 
        highWaterMark: HIGH_WATER_MARK 
      });
      
      // Handle errors
      readStream.on('error', (err) => {
        console.error(`Error reading chunk ${currentChunk}:`, err);
        reject(err);
      });
      
      // When chunk is fully read, move to next
      readStream.on('end', () => {
        currentChunk++;
        processNextChunk();
      });
      
      // Pipe this chunk to output stream (without ending it)
      readStream.pipe(outputStream, { end: false });
    }
    
    // Start processing chunks
    processNextChunk();
  });
}

// Common error response helper function
function sendErrorResponse(res, statusCode, errorMessage, details = null, errorCode = null) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: false,
    error: errorMessage,
    code: errorCode,
    details: details
  }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));