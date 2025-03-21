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
const tempUploadDir = path.join(os.tmpdir(), 'file-server-chunks');
if (!fs.existsSync(tempUploadDir)) {
  fs.mkdirSync(tempUploadDir, { recursive: true });
}

// Track uploads in memory to improve performance
const uploadTracker = new Map();

// Add error tracking for uploads
const uploadErrors = new Map();

// Dynamic resource configuration
const systemConfig = {
  // System resource detection
  totalMemory: os.totalmem(),
  freeMemory: os.freemem(),
  cpuCount: os.cpus().length,
  tmpDir: os.tmpdir(),
  
  // Performance configurations - dynamically calculated based on system resources
  getHighWaterMark: function(clientSpeed, chunkSize) {
    // Calculate optimal buffer size based on available system memory and client speed
    const memPercentage = this.freeMemory / this.totalMemory;
    const baseSize = memPercentage > 0.5 ? 
      16 * 1024 * 1024 : // High memory availability - use larger buffers (16MB)
      (memPercentage > 0.3 ? 
        8 * 1024 * 1024 : // Medium memory availability (8MB)
        4 * 1024 * 1024); // Low memory availability (4MB)
    
    // Adjust based on client speed if available
    if (clientSpeed && clientSpeed > 0) {
      // Higher speeds need larger buffers to maintain throughput
      const speedAdjustment = Math.min(clientSpeed / (2 * 1024 * 1024), 4); // Scale factor 1-4
      return Math.ceil(baseSize * speedAdjustment);
    }
    
    // If no client speed, use CPU count as a scaling factor
    return Math.ceil(baseSize * Math.min(this.cpuCount / 4, 2));
  },
  
  getLowWaterMark: function(highWaterMark) {
    return Math.floor(highWaterMark / 2);
  },
  
  getUploadTimeout: function(totalChunks, chunkSize) {
    // Estimate total file size
    const estimatedFileSize = totalChunks * chunkSize;
    
    // Base timeout on file size: 24 hours for files < 1GB, scale up for larger files
    const baseTimeout = 24 * 60 * 60 * 1000; // 24 hours in ms
    
    if (estimatedFileSize < 1024 * 1024 * 1024) { // Less than 1GB
      return baseTimeout;
    } else {
      // Scale timeout based on file size, with diminishing returns for very large files
      const sizeScale = Math.log2(estimatedFileSize / (1024 * 1024 * 1024)) + 1;
      return Math.ceil(baseTimeout * sizeScale);
    }
  },
  
  getSocketTimeout: function(chunkSize, clientSpeed) {
    // Calculate how long this chunk should take to upload
    const baseTimeout = 5 * 60 * 1000; // 5 minutes base timeout
    
    if (clientSpeed && chunkSize) {
      // Estimate transfer time and add generous margin
      const transferTimeMs = (chunkSize / clientSpeed) * 1000;
      const safeTimeout = transferTimeMs * 10; // 10x margin for safety
      
      // Use at least 2 minutes, at most 20 minutes
      return Math.max(2 * 60 * 1000, Math.min(safeTimeout, 20 * 60 * 1000));
    }
    
    return baseTimeout;
  },
  
  getMemoryChunkSize: function() {
    // Scale processing chunk size based on available memory
    const memPercentage = this.freeMemory / this.totalMemory;
    
    if (memPercentage > 0.7) { // Lots of memory available
      return 2 * 1024 * 1024; // 2MB
    } else if (memPercentage > 0.4) { // Medium memory
      return 1 * 1024 * 1024; // 1MB
    } else { // Limited memory
      return 512 * 1024; // 512KB
    }
  },
  
  getFileDescriptorTimeout: function() {
    // Scale timeout based on system load
    const loadAvg = os.loadavg()[0];
    
    if (loadAvg < 1) { // System not busy
      return 60 * 60 * 1000; // 1 hour
    } else if (loadAvg < 2) { // Moderately busy
      return 30 * 60 * 1000; // 30 minutes
    } else { // Very busy
      return 15 * 60 * 1000; // 15 minutes
    }
  },
  
  // Update system resource data
  updateResourceInfo: function() {
    this.freeMemory = os.freemem();
    // Update other dynamic resources if needed
    return this;
  }
};

// Set up periodic resource update
setInterval(() => {
  systemConfig.updateResourceInfo();
}, 60 * 1000); // Update resource info every minute

// Initial write stream options template - will be customized per upload
const getWriteStreamOptions = (clientSpeed, chunkSize) => {
  // Update system info before calculating
  systemConfig.updateResourceInfo();
  
  // Get dynamic high water mark
  const highWaterMark = systemConfig.getHighWaterMark(clientSpeed, chunkSize);
  
  return {
    highWaterMark,
    lowWaterMark: systemConfig.getLowWaterMark(highWaterMark),
    flags: 'w',
    autoClose: false,
    encoding: null,
    emitClose: true
  };
};

const server = http.createServer((req, res) => {
  // Get dynamic configuration based on current system state
  systemConfig.updateResourceInfo();
  
  // Extract potential client info for socket timeout
  const clientSpeed = req.headers['x-client-speed'] ? 
    parseInt(req.headers['x-client-speed'], 10) : null;
  const chunkSize = req.headers['x-chunk-size'] ? 
    parseInt(req.headers['x-chunk-size'], 10) : null;
    
  // Dynamic socket timeout based on request info
  const socketTimeout = systemConfig.getSocketTimeout(chunkSize, clientSpeed);
  req.socket.setTimeout(socketTimeout);
  
  // Set CORS headers for cross-tab uploads
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Path, Content-Disposition, Content-Range, X-File-Id, X-Client-Speed, X-Chunk-Size');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const { pathname, query } = parse(req.url, true);

  // Speed test endpoint for client-side upload optimization
  if (req.method === 'GET' && pathname === '/speed-test') {
    try {
      // Get requested test size, default to 256KB
      const testSize = parseInt(query.size || '262144', 10);
      
      // Limit max test size to 1MB for security
      const safeSize = Math.min(testSize, 1024 * 1024);
      
      // Generate random data of specified size
      const testData = Buffer.alloc(safeSize);
      for (let i = 0; i < safeSize; i += 4) {
        // Fill with random data
        testData.writeUInt32LE(Math.floor(Math.random() * 0xFFFFFFFF), i);
      }
      
      // Send the data with appropriate headers
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': safeSize,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache'
      });
      
      res.end(testData);
    } catch (error) {
      console.error('Error in speed test:', error);
      res.writeHead(500);
      res.end('Error generating test data');
    }
  }

  // Root endpoint - serve index.html
  else if (req.method === 'GET' && pathname === '/') {
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
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Path, Content-Disposition, Content-Range, X-File-Id, X-Client-Speed, X-Chunk-Size');
      
      // Extract metadata from headers
      const fileName = decodeURIComponent(req.headers['x-file-name'] || '');
      const chunkIndex = parseInt(req.headers['x-chunk-index'] || '0', 10);
      const totalChunks = parseInt(req.headers['x-total-chunks'] || '1', 10);
      const fileId = req.headers['x-file-id'] || Date.now().toString();
      const targetPath = query.path || getCurrentPath();
      
      // Get client-side speed information if available
      const clientSpeed = parseInt(req.headers['x-client-speed'] || '0', 10);
      const chunkSize = parseInt(req.headers['x-chunk-size'] || '0', 10);
      
      // Dynamically adjust server resources based on client capabilities
      const dynamicHighWaterMark = determineOptimalBufferSize(clientSpeed, chunkSize);
      
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
        try {
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
        } catch (dirError) {
          console.error(`Error creating directory ${outputDir}:`, dirError);
          uploadErrors.set(fileId, {
            code: 'DIR_CREATE_ERROR',
            message: `Cannot create directory: ${dirError.message}`,
            timestamp: new Date().toISOString()
          });
          
          return sendErrorResponse(
            res,
            500,
            `Failed to create output directory: ${dirError.message}`,
            dirError.stack,
            'DIR_CREATE_ERROR'
          );
        }
        
        const finalFilePath = path.join(outputDir, fileName);
        
        // Dynamic upload timeout based on total file size
        const uploadTimeout = systemConfig.getUploadTimeout(totalChunks, chunkSize);
        
        // Get optimized write stream options for this client
        const writeStreamOptions = getWriteStreamOptions(clientSpeed, chunkSize);
        
        // Initialize the write stream with dynamically calculated performance settings
        try {
          const writeStream = fs.createWriteStream(finalFilePath, writeStreamOptions);
          
          // Add explicit error handler to the write stream
          writeStream.on('error', (writeError) => {
            console.error(`Write stream error for ${fileId}:`, writeError);
            uploadErrors.set(fileId, {
              code: 'WRITE_STREAM_ERROR',
              message: `File write error: ${writeError.message}`,
              details: writeError.stack,
              timestamp: new Date().toISOString()
            });
          });
          
          uploadTracker.set(fileId, {
            finalPath: finalFilePath,
            receivedChunks: new Set(),
            writeStream: writeStream,
            totalChunks: totalChunks,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            clientSpeed: clientSpeed,
            // Set a dynamic timeout for uploads based on file size
            timeout: setTimeout(() => {
              const upload = uploadTracker.get(fileId);
              if (upload && upload.writeStream) {
                upload.writeStream.end();
                console.log(`Upload timeout for ${fileId}`);
                
                // Record timeout error
                uploadErrors.set(fileId, {
                  code: 'UPLOAD_TIMEOUT',
                  message: 'Upload timed out due to inactivity',
                  timestamp: new Date().toISOString()
                });
              }
              uploadTracker.delete(fileId);
            }, uploadTimeout)
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
        } catch (writeError) {
          console.error(`Error creating write stream for ${finalFilePath}:`, writeError);
          uploadErrors.set(fileId, {
            code: 'STREAM_CREATE_ERROR',
            message: `Cannot create file: ${writeError.message}`,
            timestamp: new Date().toISOString()
          });
          
          return sendErrorResponse(
            res,
            500,
            `Failed to create output file: ${writeError.message}`,
            writeError.stack,
            'STREAM_CREATE_ERROR'
          );
        }
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
          
          // Dynamic upload timeout based on total file size
          const uploadTimeout = systemConfig.getUploadTimeout(totalChunks, chunkSize);
          
          // Get optimized write stream options for this client
          const writeStreamOptions = getWriteStreamOptions(clientSpeed, chunkSize);
          
          // Initialize the write stream with dynamically calculated performance settings
          uploadTracker.set(fileId, {
            finalPath: finalFilePath,
            receivedChunks: new Set(),
            writeStream: fs.createWriteStream(finalFilePath, writeStreamOptions),
            totalChunks: totalChunks,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            clientSpeed: clientSpeed,
            // Set a dynamic timeout for uploads based on file size
            timeout: setTimeout(() => {
              const upload = uploadTracker.get(fileId);
              if (upload && upload.writeStream) {
                upload.writeStream.end();
              }
              uploadTracker.delete(fileId);
            }, uploadTimeout)
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
      // Don't buffer the entire chunk in memory - stream it directly
      req.on('data', async (chunk) => {
        try {
          if (!upload || !upload.writeStream) {
            // If the stream was closed to free resources, reopen it
            if (upload && upload.streamClosed) {
              console.log(`Reopening stream for ${fileId}`);
              
              try {
                // Reopen write stream in append mode
                upload.writeStream = fs.createWriteStream(upload.finalPath, {
                  highWaterMark: systemConfig.getHighWaterMark(upload.clientSpeed),
                  lowWaterMark: systemConfig.getLowWaterMark(systemConfig.getHighWaterMark(upload.clientSpeed)),
                  flags: 'a', // Append mode
                  autoClose: false,
                  encoding: null
                });
                
                // Add error handler to the reopened stream
                upload.writeStream.on('error', (writeError) => {
                  console.error(`Write stream error for ${fileId} after reopening:`, writeError);
                  uploadErrors.set(fileId, {
                    code: 'WRITE_STREAM_ERROR_REOPENED',
                    message: `File write error after reopening: ${writeError.message}`,
                    details: writeError.stack,
                    timestamp: new Date().toISOString()
                  });
                });
                
                upload.streamClosed = false;
              } catch (reopenError) {
                console.error(`Error reopening write stream for ${fileId}:`, reopenError);
                uploadErrors.set(fileId, {
                  code: 'STREAM_REOPEN_ERROR',
                  message: `Cannot reopen file: ${reopenError.message}`,
                  chunkIndex: chunkIndex,
                  timestamp: new Date().toISOString()
                });
                
                if (!res.headersSent) {
                  sendErrorResponse(
                    res,
                    500,
                    `Failed to reopen output file: ${reopenError.message}`,
                    reopenError.stack,
                    'STREAM_REOPEN_ERROR'
                  );
                }
                return;
              }
            } else {
              console.error(`Upload tracker missing for ${fileId}, chunk ${chunkIndex}`);
              
              uploadErrors.set(fileId, {
                code: 'MISSING_UPLOAD_TRACKER',
                message: 'Upload tracker was lost',
                chunkIndex: chunkIndex,
                timestamp: new Date().toISOString()
              });
              
              if (!res.headersSent) {
                sendErrorResponse(
                  res,
                  500,
                  'Upload session lost - please restart upload',
                  null,
                  'MISSING_UPLOAD_TRACKER'
                );
              }
              return;
            }
          }
          
          // Update last activity timestamp
          upload.lastActivity = Date.now();
          
          // Write the chunk directly to file - handle backpressure properly
          const canContinue = upload.writeStream.write(chunk);
          
          // If backpressure detected, wait for drain before continuing
          if (!canContinue) {
            await new Promise(resolve => upload.writeStream.once('drain', resolve));
          }
        } catch (error) {
          console.error(`Error writing chunk data for ${fileId}, chunk ${chunkIndex}:`, error);
        }
      });
      
      // Track when the chunk is done
      req.on('end', () => {
        try {
          // Mark this chunk as received - no need to wait for additional processing
          const upload = uploadTracker.get(fileId);
          if (!upload) {
            console.error(`Upload tracker missing at end for ${fileId}, chunk ${chunkIndex}`);
            return;
          }
          
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
          console.error('Error in chunk completion:', error);
          sendErrorResponse(
            res, 
            500, 
            `Server error during upload completion: ${error.message || 'Unknown error'}`, 
            error.stack,
            error.code
          );
        }
      });
      
      // Error handling for chunk endpoint
      req.on('error', (error) => {
        console.error(`Chunk upload error for ${fileId}, chunk ${chunkIndex}:`, error);
        
        // Record the error for client to retrieve
        uploadErrors.set(fileId, {
          code: error.code || 'UPLOAD_ERROR',
          message: error.message || 'Unknown upload error',
          chunkIndex: chunkIndex,
          timestamp: new Date().toISOString()
        });
        
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
      
      // Record the error for future client retrieval
      if (fileId) {
        uploadErrors.set(fileId, {
          code: error.code || 'SERVER_ERROR',
          message: error.message || 'Unknown server error',
          timestamp: new Date().toISOString()
        });
      }
      
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
    const error = uploadErrors.get(fileId);
    
    if (upload) {
      // Upload session exists
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        exists: true,
        receivedChunks: Array.from(upload.receivedChunks),
        totalChunks: upload.totalChunks,
        fileName: path.basename(upload.finalPath),
        error: error || null  // Include any error information
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
            chunkCount: chunkFiles.length,
            error: error || null  // Include any error information
          }));
        } catch (error) {
          res.writeHead(500);
          res.end(JSON.stringify({
            success: false,
            error: 'Error reading temp directory',
            details: error.message
          }));
        }
      } else {
        // Check if we have an error record for this upload
        if (error) {
          res.writeHead(200);
          res.end(JSON.stringify({
            success: false,
            exists: false,
            error: error
          }));
        } else {
          // Upload doesn't exist and no error recorded
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            exists: false
          }));
        }
      }
    }
  }
  
  // New endpoint to directly report upload errors
  else if (req.method === 'GET' && pathname === '/report-upload-error') {
    const fileId = query.fileId;
    const errorMessage = query.message || 'Client reported error';
    const errorCode = query.code || 'CLIENT_ERROR';
    const chunkIndex = query.chunkIndex ? parseInt(query.chunkIndex, 10) : undefined;
    
    if (!fileId) {
      res.writeHead(400);
      return res.end(JSON.stringify({ 
        success: false, 
        error: 'Missing fileId parameter' 
      }));
    }
    
    // Record the client-reported error
    uploadErrors.set(fileId, {
      code: errorCode,
      message: errorMessage,
      chunkIndex: chunkIndex,
      clientReported: true,
      timestamp: new Date().toISOString()
    });
    
    // Respond with success
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      message: 'Error reported successfully'
    }));
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
  uploadErrors.clear();
  process.exit(0);
});

// Periodically clean up stale uploads (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [fileId, upload] of uploadTracker.entries()) {
    // Update system resource info before calculating timeouts
    systemConfig.updateResourceInfo();
    
    // Calculate dynamic timeout for this upload
    const dynamicTimeout = upload.clientSpeed ? 
      systemConfig.getUploadTimeout(upload.totalChunks, upload.chunkSize) : 
      24 * 60 * 60 * 1000; // 24 hour default
    
    // If upload is older than dynamic timeout and not completed
    if (now - upload.createdAt > dynamicTimeout) {
      console.log(`Cleaning up stale upload: ${fileId}`);
      if (upload.writeStream) {
        upload.writeStream.end();
      }
      clearTimeout(upload.timeout);
      uploadTracker.delete(fileId);
      uploadErrors.delete(fileId);  // Clean up error records too
    }
    // Close idle write streams to free up file descriptors
    else {
      // Calculate dynamic file descriptor timeout based on system load
      const fdTimeout = systemConfig.getFileDescriptorTimeout();
      
      if (now - upload.lastActivity > fdTimeout && upload.writeStream && !upload.writeStream.closed) {
        console.log(`Closing idle write stream for ${fileId} to free resources`);
        
        // Store the final path so we can reopen when needed
        const finalPath = upload.finalPath;
        const receivedChunks = upload.receivedChunks;
        
        // Close the stream properly
        upload.writeStream.end();
        
        // Update tracker with null write stream but keep other data
        uploadTracker.set(fileId, {
          ...upload,
          writeStream: null,
          finalPath: finalPath,
          receivedChunks: receivedChunks,
          streamClosed: true
        });
      }
    }
  }
  
  // Also clean up old error records
  for (const [fileId, error] of uploadErrors.entries()) {
    if (now - new Date(error.timestamp).getTime() > 24 * 60 * 60 * 1000) {
      // Remove error records older than 24 hours
      uploadErrors.delete(fileId);
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
        
        // Record the error
        if (fileId) {
          uploadErrors.set(fileId, {
            code: 'READ_ERROR',
            message: `Failed to read chunk ${currentChunk}: ${err.message}`,
            chunkIndex: currentChunk,
            timestamp: new Date().toISOString()
          });
        }
        
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

// Helper function to determine optimal buffer size based on client capabilities
function determineOptimalBufferSize(clientSpeed, chunkSize) {
  // Update system resources
  systemConfig.updateResourceInfo();
  
  // If no client speed info, calculate based on system resources only
  if (!clientSpeed || !chunkSize) {
    return systemConfig.getHighWaterMark();
  }
  
  // Return dynamically calculated high water mark
  return systemConfig.getHighWaterMark(clientSpeed, chunkSize);
}

// Helper function to format sizes
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));