const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('url');
const { exec } = require('child_process');
const os = require('os');
const events = require('events');
const crypto = require('crypto');

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
      32 * 1024 * 1024 : // High memory availability - use larger buffers (32MB)
      (memPercentage > 0.3 ? 
        16 * 1024 * 1024 : // Medium memory availability (16MB)
        8 * 1024 * 1024); // Low memory availability (8MB)
    
    // Adjust based on client speed if available
    if (clientSpeed && clientSpeed > 0) {
      // Higher speeds need larger buffers to maintain throughput
      const speedAdjustment = Math.min(clientSpeed / (1 * 1024 * 1024), 8); // Scale factor 1-8
      return Math.ceil(baseSize * speedAdjustment);
    }
    
    // If no client speed, use CPU count as a scaling factor
    return Math.ceil(baseSize * Math.min(this.cpuCount / 2, 4));
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

  // Speed test endpoint for client to measure network speed
  if (req.method === 'GET' && pathname === '/speed-test') {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    try {
      // Parse requested size (with max limit to prevent abuse)
      const requestedSize = query.size || '500KB';
      let sizeInBytes = 0;
      
      if (requestedSize.endsWith('KB')) {
        sizeInBytes = parseInt(requestedSize.substring(0, requestedSize.length - 2)) * 1024;
      } else if (requestedSize.endsWith('MB')) {
        sizeInBytes = parseInt(requestedSize.substring(0, requestedSize.length - 2)) * 1024 * 1024;
      } else {
        sizeInBytes = parseInt(requestedSize);
      }
      
      // Cap at 1MB to prevent abuse
      sizeInBytes = Math.min(sizeInBytes, 1024 * 1024);
      
      // Create a buffer of random data
      const buffer = Buffer.alloc(sizeInBytes);
      
      // Fill buffer with random data to prevent compression
      crypto.randomFillSync(buffer);
      
      // Set appropriate headers for download
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      console.log(`Serving speed test data: ${formatSize(sizeInBytes)}`);
      
      // Send the buffer
      res.writeHead(200);
      res.end(buffer);
    } catch (error) {
      console.error('Error in speed test endpoint:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'Failed to generate speed test data'
      }));
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

      // Create output directory if it doesn't exist
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
      
      // Final file path (where the file will be saved)
      const finalFilePath = path.join(outputDir, fileName);
      
      // Check if this is a single-chunk direct upload (non-chunked)
      const isSingleChunkUpload = totalChunks === 1 && chunkIndex === 0;
      
      if (isSingleChunkUpload) {
        console.log(`Starting direct file upload for ${fileName} to ${finalFilePath}`);
        
        // Get optimized write stream options for this client
        const writeStreamOptions = getWriteStreamOptions(clientSpeed, chunkSize);
        
        try {
          // Create write stream with optimized settings
          const writeStream = fs.createWriteStream(finalFilePath, writeStreamOptions);
          
          // Add error handler
          writeStream.on('error', (writeError) => {
            console.error(`Write stream error for ${fileName}:`, writeError);
            if (!res.headersSent) {
              sendErrorResponse(
                res,
                500,
                `File write error: ${writeError.message}`,
                writeError.stack,
                'WRITE_STREAM_ERROR'
              );
            }
          });
          
          // Pipe the request directly to the file
          req.pipe(writeStream);
          
          // When the request finishes, close the file and respond
          req.on('end', () => {
            writeStream.end();
            
            // Wait for write to complete before responding
            writeStream.on('finish', () => {
              console.log(`File upload complete: ${fileName} at ${finalFilePath}`);
              console.log(`File size: ${fs.statSync(finalFilePath).size} bytes`);
              
              if (!res.headersSent) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  success: true,
                  message: 'File upload complete',
                  filePath: finalFilePath
                }));
              }
            });
          });
          
          // Handle errors on the request
          req.on('error', (reqError) => {
            console.error(`Request error for ${fileName}:`, reqError);
            writeStream.end();
            
            if (!res.headersSent) {
              sendErrorResponse(
                res,
                500,
                `Upload error: ${reqError.message}`,
                reqError.stack,
                'REQUEST_ERROR'
              );
            }
          });
          
          return; // Exit early as we're handling the response in the callbacks
        } catch (streamError) {
          console.error(`Error creating write stream for ${finalFilePath}:`, streamError);
          return sendErrorResponse(
            res,
            500,
            `Failed to create file stream: ${streamError.message}`,
            streamError.stack,
            'STREAM_CREATE_ERROR'
          );
        }
      }
      
      // If first chunk, initialize the upload tracker
      if (chunkIndex === 0) {
        // Dynamic upload timeout based on total file size
        const uploadTimeout = systemConfig.getUploadTimeout(totalChunks, chunkSize);
        
        // Get optimized write stream options for this client
        const writeStreamOptions = getWriteStreamOptions(clientSpeed, chunkSize);
        
        // Set flags based on whether we're starting a new file or appending
        writeStreamOptions.flags = 'w'; // 'w' to create/overwrite, 'a' to append
        
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
            writePosition: 0, // Track bytes written to file
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
          
          console.log(`New upload started: ${fileName} (${fileId}) at ${finalFilePath}`);
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
        
        // Respond immediately for the first chunk to avoid client waiting
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Upload session initialized',
          fileId: fileId
        }));
      } else {
        // Get the upload tracker for this file
        const upload = uploadTracker.get(fileId);
        if (!upload) {
          return sendErrorResponse(
            res, 
            400, 
            'Upload session not found. The upload may have expired or the first chunk was not received.', 
            { chunkIndex, fileId },
            'SESSION_NOT_FOUND'
          );
        }
        
        // Check if this chunk was already received (handle retries)
        if (upload.receivedChunks.has(chunkIndex)) {
          res.writeHead(200);
          return res.end(JSON.stringify({ 
            success: true, 
            message: `Chunk ${chunkIndex + 1}/${totalChunks} already received`
          }));
        }
        
        // If we need to respond to the client before processing data
        if (chunkIndex > 0 && !res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Processing chunk ${chunkIndex + 1}/${totalChunks}`,
            fileId: fileId
          }));
        }
      }
      
      // Get the upload tracker (it should exist by this point)
      const upload = uploadTracker.get(fileId);
      
      // Prepare to collect the chunk data
      let chunkData = Buffer.alloc(0);
      let chunkHash = crypto.createHash('md5');
      
      // Receive and process the data
      req.on('data', async (chunk) => {
        try {
          // Update last activity timestamp
          if (upload) {
            upload.lastActivity = Date.now();
          } else {
            console.error(`Upload tracker missing for ${fileId}, chunk ${chunkIndex}`);
            uploadErrors.set(fileId, {
              code: 'MISSING_UPLOAD_TRACKER',
              message: 'Upload tracker was lost',
              chunkIndex: chunkIndex,
              timestamp: new Date().toISOString()
            });
            return;
          }
          
          // Update hash
          chunkHash.update(chunk);
          
          // Add to chunk data
          chunkData = Buffer.concat([chunkData, chunk]);
          
          // Write directly to the file if we have a write stream
          if (upload.writeStream) {
            // For sequential writes (when chunks arrive in order)
            if (chunkIndex === upload.receivedChunks.size) {
              // Write the chunk directly to file - handle backpressure properly
              const canContinue = upload.writeStream.write(chunk);
              
              // If backpressure detected, wait for drain before continuing
              if (!canContinue) {
                await new Promise(resolve => upload.writeStream.once('drain', resolve));
              }
              
              // Update write position
              upload.writePosition += chunk.length;
            }
          }
        } catch (error) {
          console.error(`Error processing chunk data for ${fileId}, chunk ${chunkIndex}:`, error);
          uploadErrors.set(fileId, {
            code: 'CHUNK_PROCESSING_ERROR',
            message: `Failed to process chunk data: ${error.message}`,
            chunkIndex: chunkIndex,
            timestamp: new Date().toISOString()
          });
        }
      });
      
      // Track when the chunk is done
      req.on('end', () => {
        try {
          // Check if upload tracker still exists
          const upload = uploadTracker.get(fileId);
          if (!upload) {
            console.error(`Upload tracker missing at end for ${fileId}, chunk ${chunkIndex}`);
            return;
          }
          
          // Calculate MD5 hash of the chunk
          const md5Hash = chunkHash.digest('hex');
          console.log(`Chunk ${chunkIndex} MD5: ${md5Hash}`);
          
          // Mark this chunk as received
          upload.receivedChunks.add(chunkIndex);
          
          // Log progress
          console.log(`Received chunk ${chunkIndex + 1}/${totalChunks} for ${fileId} (${chunkData.length} bytes)`);
          
          // If the chunk wasn't written directly (out of order), handle it here
          if (chunkIndex !== upload.receivedChunks.size - 1 && upload.writeStream) {
            // For now, we'll keep track of what we've received and let the client know
            console.log(`Received out-of-order chunk ${chunkIndex} for ${fileId}`);
          }
          
          // Check if all chunks have been received
          if (upload.receivedChunks.size === totalChunks) {
            // Close the file stream
            console.log(`File upload complete: ${fileName} (${fileId}), finalizing at: ${upload.finalPath}`);
            
            // End the write stream but wait for it to finish before cleaning up
            upload.writeStream.end();
            upload.writeStream.on('finish', () => {
              console.log(`File write stream finished: ${fileName} (${fileId}) at ${upload.finalPath}`);
              console.log(`File exists check: ${fs.existsSync(upload.finalPath)}`);
              console.log(`File size: ${fs.existsSync(upload.finalPath) ? fs.statSync(upload.finalPath).size : 'N/A'} bytes`);
              
              // Clean up
              clearTimeout(upload.timeout);
              uploadTracker.delete(fileId);
            });
            
            // Send response for last chunk if we haven't already
            if (!res.headersSent) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                message: 'File upload complete',
                filePath: upload.finalPath
              }));
            }
          } else if (!res.headersSent) {
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
          uploadErrors.set(fileId, {
            code: 'CHUNK_COMPLETION_ERROR',
            message: `Failed to complete chunk processing: ${error.message}`,
            chunkIndex: chunkIndex,
            timestamp: new Date().toISOString()
          });
          
          if (!res.headersSent) {
            sendErrorResponse(
              res, 
              500, 
              `Server error during upload completion: ${error.message || 'Unknown error'}`, 
              error.stack,
              error.code
            );
          }
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
        
        if (!res.headersSent) {
          sendErrorResponse(
            res,
            500,
            `Error uploading chunk: ${error.code || error.message || 'Unknown error'}`,
            error.message,
            error.code
          );
        }
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
  
  // Check upload status endpoint
  else if (req.method === 'GET' && pathname === '/check-upload') {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Get fileId from query
    const fileId = query.fileId;
    
    if (!fileId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: false,
        exists: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'Missing fileId parameter'
        }
      }));
    }
    
    // Check if the upload exists in our tracker
    const upload = uploadTracker.get(fileId);
    
    if (!upload) {
      // Check if we have any error records for this upload
      const error = uploadErrors.get(fileId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        exists: false,
        error: error || null
      }));
    }
    
    // Get the chunks received so far
    const receivedChunks = Array.from(upload.receivedChunks);
    
    // Send back status
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      exists: true,
      receivedChunks: receivedChunks,
      totalChunks: upload.totalChunks,
      lastActivity: upload.lastActivity,
      elapsedTime: Date.now() - upload.createdAt,
      error: uploadErrors.get(fileId) || null
    }));
  }
  
  // Report upload error endpoint - allows clients to report errors
  else if (req.method === 'GET' && pathname === '/report-upload-error') {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Get parameters from query
    const fileId = query.fileId;
    const code = query.code || 'CLIENT_ERROR';
    const message = query.message || 'Unknown client error';
    const chunkIndex = query.chunkIndex !== undefined ? parseInt(query.chunkIndex, 10) : null;
    
    if (!fileId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: false,
        error: 'Missing fileId parameter'
      }));
    }
    
    // Record the error
    uploadErrors.set(fileId, {
      code,
      message,
      chunkIndex,
      timestamp: new Date().toISOString(),
      reportedBy: 'client'
    });
    
    // Log the error
    console.log(`Client reported upload error for ${fileId}:`, code, message);
    
    // Send success response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Error reported successfully'
    }));
  }
  
  // File list endpoint
  else if (req.method === 'GET' && pathname === '/list-files') {
    // Get directory path from query
    const dirPath = query.path || getCurrentPath();
    
    try {
      // Resolve the path
      const fullPath = path.resolve(dirPath);
      
      // Check if the path exists and is a directory
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        // Read the directory
        fs.readdir(fullPath, (err, files) => {
          if (err) {
            res.writeHead(500);
            return res.end(JSON.stringify({ 
              success: false, 
              error: 'Failed to read directory contents' 
            }));
          }
          
          // Filter out directories if needed
          const filesList = files.filter(file => {
            try {
              const filePath = path.join(fullPath, file);
              return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
            } catch (error) {
              return false;
            }
          });
          
          // Send the list of files
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            path: dirPath,
            files: filesList
          }));
        });
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Directory not found' 
        }));
      }
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ 
        success: false, 
        error: 'Failed to list files: ' + error.message 
      }));
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
  uploadErrors.clear();
  process.exit(0);
});

// Function to periodically clean up stale uploads
function setupUploadCleanup() {
  setInterval(() => {
    const now = Date.now();
    let cleanedUp = 0;
    
    // Check each upload
    for (const [fileId, upload] of uploadTracker.entries()) {
      // If last activity was more than our timeout ago, clean up
      const inactiveTime = now - upload.lastActivity;
      const uploadTimeout = systemConfig.getUploadTimeout(upload.totalChunks, upload.chunkSize);
      
      if (inactiveTime > uploadTimeout) {
        console.log(`Cleaning up stale upload ${fileId}, inactive for ${formatTime(inactiveTime / 1000)}`);
        
        // Close the write stream if it's still open
        if (upload.writeStream) {
          try {
            upload.writeStream.end();
          } catch (err) {
            console.error(`Error closing write stream for ${fileId}:`, err);
          }
        }
        
        // If the upload didn't complete, mark the file as incomplete
        if (upload.receivedChunks.size < upload.totalChunks) {
          try {
            // Optionally, add a ".incomplete" extension to the file
            if (fs.existsSync(upload.finalPath)) {
              fs.renameSync(upload.finalPath, `${upload.finalPath}.incomplete`);
              console.log(`Marked incomplete file: ${upload.finalPath}.incomplete`);
            }
          } catch (err) {
            console.error(`Error marking incomplete file for ${fileId}:`, err);
          }
        }
        
        // Clear the timeout and delete from tracker
        clearTimeout(upload.timeout);
        uploadTracker.delete(fileId);
        cleanedUp++;
      }
    }
    
    // Also clean up old error records
    const errorCleanupTime = 24 * 60 * 60 * 1000; // 24 hours
    let cleanedErrors = 0;
    
    for (const [fileId, error] of uploadErrors.entries()) {
      const errorTime = new Date(error.timestamp).getTime();
      if (now - errorTime > errorCleanupTime) {
        uploadErrors.delete(fileId);
        cleanedErrors++;
      }
    }
    
    if (cleanedUp > 0 || cleanedErrors > 0) {
      console.log(`Cleanup: removed ${cleanedUp} stale uploads and ${cleanedErrors} old error records`);
    }
  }, 60000); // Check every minute
}

// Call setup function when server starts
setupUploadCleanup();

// Helper function to parse human-readable time
function formatTime(seconds) {
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  } else {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
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

// Helper function to format sizes
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));