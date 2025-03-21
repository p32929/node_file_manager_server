const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('url');
const { exec } = require('child_process');
const os = require('os');

// Create temp directory for chunk uploads
const TEMP_DIR = path.join(os.tmpdir(), 'file-server-chunks');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Track uploads in memory to improve performance
const uploadTracker = new Map();

// Performance settings
const HIGH_WATER_MARK = 1024 * 1024; // 1MB buffer for write streams
const UPLOAD_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours timeout for uploads

const server = http.createServer((req, res) => {
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
      res.end(JSON.stringify({ path: '/', folders: [], error: err.message }));
    }
  }
  
  // New endpoint for chunk uploads
  else if (req.method === 'POST' && pathname === '/upload-chunk') {
    try {
      // Use nodejs stream capabilities for efficient uploads
      // Extract metadata from headers
      const fileName = req.headers['x-file-name'];
      const chunkIndex = parseInt(req.headers['x-chunk-index']);
      const totalChunks = parseInt(req.headers['x-total-chunks']);
      const targetPath = req.headers['x-file-path'] || getCurrentPath();
      
      if (!fileName || isNaN(chunkIndex) || isNaN(totalChunks)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Missing or invalid headers' }));
      }
      
      // For non-first chunks, try to get fileId from header
      let fileId;
      if (chunkIndex > 0 && req.headers['x-file-id']) {
        fileId = req.headers['x-file-id'];
        console.log(`Using provided fileId for chunk ${chunkIndex}: ${fileId}`);
      } else {
        // For first chunk, create a new fileId
        fileId = fileName + '-' + totalChunks;
        console.log(`Generated new fileId for first chunk: ${fileId}`);
      }
      
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
            flags: 'w'
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
              flags: 'w'
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
          res.writeHead(400);
          return res.end(JSON.stringify({ 
            error: 'Upload session not found. The upload may have expired or the first chunk was not received.',
            shouldRestart: true
          }));
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
      req.pipe(upload.writeStream, { end: false });
      
      // Track when the chunk is done
      req.on('end', () => {
        // Mark this chunk as received
        upload.receivedChunks.add(chunkIndex);
        
        // Check if all chunks have been received
        if (upload.receivedChunks.size === upload.totalChunks) {
          // Close the file stream
          upload.writeStream.end(() => {
            console.log(`Upload complete: ${fileName} (${fileId})`);
          });
          
          // Clear the timeout and remove from tracker
          clearTimeout(upload.timeout);
          uploadTracker.delete(fileId);
          
          // Send success response
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            message: 'File upload complete',
            filePath: upload.finalPath
          }));
        } else {
          // More chunks expected
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            message: `Chunk ${chunkIndex + 1}/${totalChunks} received`,
            received: upload.receivedChunks.size,
            fileId: fileId
          }));
        }
      });
      
      // Handle errors
      req.on('error', (error) => {
        console.error(`Chunk upload error for ${fileId}, chunk ${chunkIndex}:`, error);
        res.writeHead(500);
        res.end(JSON.stringify({
          error: 'Error uploading chunk',
          details: error.message
        }));
      });
    } catch (error) {
      console.error('Error in chunk upload:', error);
      res.writeHead(500);
      res.end(`Server error during upload: ${error.message}`);
    }
  }
  
  // Traditional file upload endpoint
  else if (req.method === 'POST' && pathname === '/upload') {
    const contentType = req.headers['content-type'];
    
    if (!contentType || !contentType.includes('multipart/form-data')) {
      res.writeHead(400);
      return res.end('Invalid content type, expected multipart/form-data');
    }
    
    const boundary = contentType.split('boundary=')[1];
    let body = Buffer.alloc(0);

    req.on('data', chunk => body = Buffer.concat([body, chunk]));

    req.on('end', () => {
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
        return res.end('Missing fields');
      }

      // Create upload directory if it doesn't exist
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }

      const fullPath = path.join(destPath, fileName);
      try {
        fs.writeFileSync(fullPath, fileBuffer);
        res.writeHead(200);
        res.end(`Uploaded to ${fullPath}`);
      } catch (e) {
        res.writeHead(500);
        res.end('Failed to save: ' + e.message);
      }
    });
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
  return process.cwd();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));