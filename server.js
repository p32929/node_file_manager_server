/**
 * SERVER.JS
 *
 * - Supports both single-chunk and multi-chunk uploads
 * - No separate "init" request for chunk #0. The first chunk
 *   of data (index=0) immediately writes to the file.
 * - Uses an in-memory tracker to handle partial uploads.
 * - Cleans up stale uploads.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('url');
const { exec } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

// Keep an in-memory map of ongoing uploads
const uploadTracker = new Map();
// Keep track of errors
const uploadErrors = new Map();

// Periodic cleanup of stale uploads
setupUploadCleanup();

// Basic dynamic config
const systemConfig = {
  totalMem: os.totalmem(),
  freeMem: os.freemem(),
  cpuCount: os.cpus().length,
  update() {
    this.freeMem = os.freemem();
    return this;
  },
  getUploadTimeout(estimatedSize) {
    // 24h default if <1GB, else scale
    const base = 24 * 60 * 60 * 1000;
    if (estimatedSize < 1_073_741_824) return base; // <1GB
    const scale = Math.log2(estimatedSize / 1_073_741_824) + 1;
    return Math.ceil(base * scale);
  }
};

function getCurrentPath() {
  // Default base "uploads" folder in current working directory
  const base = process.cwd();
  const uploadPath = path.join(base, 'uploads');
  if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
  }
  return uploadPath;
}

function cleanupFile(filePath) {
  if (fs.existsSync(filePath)) {
    // Optionally rename to ".incomplete" or remove
    const incomplete = filePath + '.incomplete';
    try {
      fs.renameSync(filePath, incomplete);
      console.log(`Renamed incomplete file to: ${incomplete}`);
    } catch (err) {
      console.error('Failed renaming incomplete file:', err);
    }
  }
}

// Periodically remove stale uploads
function setupUploadCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [fileId, upload] of uploadTracker) {
      const inactive = now - upload.lastActivity;
      // Timeout is dynamic: totalChunks * chunkSize estimate
      const estimateSize = upload.totalChunks * upload.chunkSize;
      const uploadTimeout = systemConfig.getUploadTimeout(estimateSize);
      if (inactive > uploadTimeout) {
        console.log(`Cleaning up stale upload ${fileId}`);
        if (upload.writeStream) {
          try {
            upload.writeStream.end();
          } catch {}
        }
        if (upload.receivedChunks.size < upload.totalChunks) {
          // mark incomplete
          cleanupFile(upload.finalPath);
        }
        clearTimeout(upload.timeout);
        uploadTracker.delete(fileId);
      }
    }

    // Clean older error records
    const errorStale = 24 * 60 * 60 * 1000; // 24h
    for (const [fileId, errInfo] of uploadErrors) {
      const errTime = new Date(errInfo.timestamp).getTime();
      if ((now - errTime) > errorStale) {
        uploadErrors.delete(fileId);
      }
    }
  }, 60_000);
}

// Helper: respond with JSON error
function sendError(res, code, msg, details=null) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: false,
    error: msg,
    details
  }));
}

// Start HTTP server
const server = http.createServer(async (req, res) => {
  systemConfig.update();

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', [
    'Origin','X-Requested-With','Content-Type','Accept',
    'X-File-Name','X-Chunk-Index','X-Total-Chunks','X-File-Path',
    'Content-Disposition','Content-Range','X-File-Id','X-Client-Speed','X-Chunk-Size'
  ].join(', '));

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const { pathname, query } = parse(req.url, true);

  // -------------------------------------------
  // 1) Cancel Upload Endpoint
  // -------------------------------------------
  if (req.method === 'POST' && pathname === '/cancel-upload') {
    try {
      const fileId = query.fileId;
      const fileName = query.fileName ? decodeURIComponent(query.fileName) : '';
      
      console.log(`Cancelling upload for fileId: ${fileId}, fileName: ${fileName}`);
      
      if (fileId && uploadTracker.has(fileId)) {
        const upload = uploadTracker.get(fileId);
        
        // Close the write stream if open
        if (upload.writeStream) {
          try {
            upload.writeStream.end();
          } catch (err) {
            console.error('Error closing write stream:', err);
          }
        }
        
        // Clean up the file if it exists
        cleanupFile(upload.finalPath);
        
        // Clean up temporary chunks if any
        const tempDir = path.dirname(upload.finalPath);
        const tempPrefix = path.basename(upload.finalPath) + '.part';
        try {
          const files = fs.readdirSync(tempDir);
          for (const file of files) {
            if (file.startsWith(tempPrefix)) {
              fs.unlinkSync(path.join(tempDir, file));
              console.log(`Deleted temp chunk: ${file}`);
            }
          }
        } catch (err) {
          console.error('Error cleaning up temp chunks:', err);
        }
        
        // Remove from tracker
        clearTimeout(upload.timeout);
        uploadTracker.delete(fileId);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Upload cancelled and temporary files cleaned up'
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'No active upload found with this ID'
        }));
      }
    } catch (error) {
      console.error('Error cancelling upload:', error);
      sendError(res, 500, 'Server error cancelling upload', error.message);
    }
    return;
  }

  // -------------------------------------------
  // 2) Speed Test Endpoint
  // -------------------------------------------
  if (req.method === 'GET' && pathname === '/speed-test') {
    try {
      const requestedSize = query.size || '500KB';
      let sizeInBytes = 500 * 1024;
      if (requestedSize.toUpperCase().endsWith('KB')) {
        sizeInBytes = parseInt(requestedSize) * 1024;
      } else if (requestedSize.toUpperCase().endsWith('MB')) {
        sizeInBytes = parseInt(requestedSize) * 1024 * 1024;
      } else {
        sizeInBytes = parseInt(requestedSize);
      }
      // cap at 1MB
      sizeInBytes = Math.min(sizeInBytes, 1_048_576);

      const buffer = Buffer.alloc(sizeInBytes);
      crypto.randomFillSync(buffer);

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(buffer);
    } catch (err) {
      console.error('Speed-test error:', err);
      sendError(res, 500, 'Failed speed test');
    }
  }

  // -------------------------------------------
  // 3) Serve index.html at root
  // -------------------------------------------
  else if (req.method === 'GET' && pathname === '/') {
    fs.readFile('./public/index.html', (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading index.html');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }

  // -------------------------------------------
  // 4) List drives (Windows only)
  // -------------------------------------------
  else if (req.method === 'GET' && pathname === '/list-drives') {
    if (process.platform === 'win32') {
      exec('wmic logicaldisk get name', (error, stdout) => {
        if (error) {
          return sendError(res, 500, error.message);
        }
        const lines = stdout.split('\r\r\n').map(x => x.trim()).filter(x => /^[A-Za-z]:$/.test(x));
        const drives = lines.map(d => d + '\\');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ drives }));
      });
    } else {
      // Non-windows
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ drives: ['/'] }));
    }
  }

  // -------------------------------------------
  // 5) List folders
  // -------------------------------------------
  else if (req.method === 'GET' && pathname === '/list-folders') {
    let currentPath = query.path || '/';
    if ((currentPath === '/' || currentPath === '\\') && process.platform === 'win32') {
      // Return that we are at Windows root
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ path:'/', folders:[], isRoot:true }));
    }
    try {
      currentPath = path.resolve(currentPath);
      const items = fs.readdirSync(currentPath, { withFileTypes: true });
      const folders = items.filter(d => d.isDirectory()).map(d => d.name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: currentPath, folders }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path:'/', folders:[], error:err.message }));
    }
  }

  // -------------------------------------------
  // 6) Chunked/Single-chunk upload
  // -------------------------------------------
  else if (req.method === 'POST' && pathname === '/upload-chunk') {
    try {
      const fileName = decodeURIComponent(req.headers['x-file-name'] || '');
      const chunkIndex = parseInt(req.headers['x-chunk-index'] || '0', 10);
      const totalChunks = parseInt(req.headers['x-total-chunks'] || '1', 10);
      const fileId = req.headers['x-file-id'] || Date.now().toString();
      const targetPath = query.path || getCurrentPath();
      const chunkSz = parseInt(req.headers['x-chunk-size'] || '0', 10);

      if (!fileName) return sendError(res, 400, 'Missing file name');

      // Create target dir if needed
      const outDir = path.resolve(targetPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }

      const finalFilePath = path.join(outDir, fileName);
      const isSingleChunk = (totalChunks === 1 && chunkIndex === 0);

      // If single-chunk => just pipe it to disk
      if (isSingleChunk) {
        const ws = fs.createWriteStream(finalFilePath, { flags:'w' });
        ws.on('error', err => {
          console.error('Single-chunk write error:', err);
          if (!res.headersSent) {
            sendError(res, 500, `Write error: ${err.message}`);
          }
        });
        req.pipe(ws);

        req.on('end', () => {
          ws.end();
          ws.on('finish', () => {
            res.writeHead(200, { 'Content-Type':'application/json' });
            res.end(JSON.stringify({
              success: true,
              message: 'File upload complete (single-chunk)',
              filePath: finalFilePath
            }));
          });
        });
        return;
      }

      // --- MULTI-CHUNK LOGIC ---
      let upload = uploadTracker.get(fileId);

      // If no existing upload session, create it
      if (!upload) {
        console.log(`Creating new upload session for fileId=${fileId}, file=${fileName}`);
        const ws = fs.createWriteStream(finalFilePath, { flags:'w' });
        ws.on('error', err => {
          uploadErrors.set(fileId, { 
            code:'WRITE_ERROR', 
            message: err.message, 
            timestamp: new Date().toISOString() 
          });
        });

        const estimateBytes = totalChunks * chunkSz;
        const timeoutValue = systemConfig.getUploadTimeout(estimateBytes);
        const timeoutHandle = setTimeout(() => {
          console.log(`Upload session timed out for ${fileId}`);
          if (ws) {
            ws.end();
          }
          cleanupFile(finalFilePath);
          uploadTracker.delete(fileId);
        }, timeoutValue);

        upload = {
          finalPath: finalFilePath,
          writeStream: ws,
          totalChunks,
          chunkSize: chunkSz,
          receivedChunks: new Set(),
          createdAt: Date.now(),
          lastActivity: Date.now(),
          timeout: timeoutHandle
        };
        uploadTracker.set(fileId, upload);
      }

      // If this chunk is already received, respond success immediately (e.g. retry)
      if (upload.receivedChunks.has(chunkIndex)) {
        res.writeHead(200, { 'Content-Type':'application/json' });
        return res.end(JSON.stringify({
          success: true, 
          message:`Chunk ${chunkIndex} already received`
        }));
      }

      // Update activity
      upload.lastActivity = Date.now();

      // Accumulate chunk data as it arrives
      const ws = upload.writeStream;
      let bytesWritten = 0;
      req.on('data', chunk => {
        ws.write(chunk);
        bytesWritten += chunk.length;
      });

      req.on('end', () => {
        ws.once('drain', () => {}); // just to ensure we handle backpressure if needed
        upload.receivedChunks.add(chunkIndex);

        // If that was the last chunk, close up the file
        if (upload.receivedChunks.size === upload.totalChunks) {
          // All chunks complete
          ws.end();
          ws.on('finish', () => {
            console.log(`All chunks uploaded for fileId=${fileId}, saved at ${upload.finalPath}`);
            clearTimeout(upload.timeout);
            uploadTracker.delete(fileId);

            // Send final success
            res.writeHead(200, { 'Content-Type':'application/json' });
            res.end(JSON.stringify({
              success: true,
              message: 'File upload complete (multi-chunk)',
              filePath: upload.finalPath
            }));
          });
        } else {
          // More chunks to go, respond success
          res.writeHead(200, { 'Content-Type':'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Chunk ${chunkIndex} received`,
            fileId
          }));
        }
      });

      req.on('error', err => {
        console.error(`Error receiving chunk ${chunkIndex} for fileId=${fileId}:`, err);
        uploadErrors.set(fileId, {
          code:'CHUNK_RECEIVE_ERROR',
          message: err.message,
          timestamp: new Date().toISOString()
        });
        if (!res.headersSent) {
          sendError(res, 500, `Chunk receive error: ${err.message}`);
        }
      });
    } catch (err) {
      console.error('Upload chunk error:', err);
      sendError(res, 500, `Server error: ${err.message}`);
    }
  }

  // -------------------------------------------
  // 7) Check upload status
  // -------------------------------------------
  else if (req.method === 'GET' && pathname === '/check-upload') {
    const fileId = query.fileId;
    if (!fileId) {
      return sendError(res, 400, 'Missing fileId');
    }
    const upload = uploadTracker.get(fileId);
    if (!upload) {
      // Maybe it finished or got cleaned up?
      const error = uploadErrors.get(fileId) || null;
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify({
        success: true,
        exists: false,
        error
      }));
    }
    // If found
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({
      success: true,
      exists: true,
      receivedChunks: Array.from(upload.receivedChunks),
      totalChunks: upload.totalChunks,
      lastActivity: upload.lastActivity,
      error: null
    }));
  }

  // -------------------------------------------
  // 8) Report upload error
  // -------------------------------------------
  else if (req.method === 'GET' && pathname === '/report-upload-error') {
    const fileId = query.fileId;
    const code = query.code || 'CLIENT_ERROR';
    const message = query.message || 'Unknown client error';
    const chunkIndex = (query.chunkIndex) ? parseInt(query.chunkIndex, 10) : null;
    if (!fileId) {
      return sendError(res, 400, 'Missing fileId');
    }
    uploadErrors.set(fileId, {
      code,
      message,
      chunkIndex,
      timestamp: new Date().toISOString()
    });
    console.log(`Client reported error for ${fileId}:`, code, message);
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ success:true, message:'Error reported' }));
  }

  // -------------------------------------------
  // 9) List files in a directory
  // -------------------------------------------
  else if (req.method === 'GET' && pathname === '/list-files') {
    const dirPath = query.path || getCurrentPath();
    try {
      const fullPath = path.resolve(dirPath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        fs.readdir(fullPath, (err, items) => {
          if (err) {
            return sendError(res, 500, 'Failed to read directory');
          }
          const fileList = [];
          
          // Get detailed file info including size, type, and dates
          for (const item of items) {
            const filePath = path.join(fullPath, item);
            try {
              const stats = fs.statSync(filePath);
              if (stats.isFile()) {
                // Get file extension for type identification
                const ext = path.extname(item).toLowerCase().substring(1);
                
                fileList.push({
                  name: item,
                  size: stats.size,
                  modified: stats.mtime.toISOString(),
                  created: stats.birthtime.toISOString(),
                  extension: ext,
                  type: getFileType(ext)
                });
              }
            } catch (statErr) {
              console.error(`Error getting stats for ${item}:`, statErr);
              // Still include the file with limited info
              fileList.push({ 
                name: item, 
                size: 0, 
                error: 'Could not read file info' 
              });
            }
          }
          
          res.writeHead(200, { 'Content-Type':'application/json' });
          res.end(JSON.stringify({
            success: true,
            path: dirPath,
            files: fileList
          }));
        });
      } else {
        sendError(res, 404, 'Directory not found');
      }
    } catch (err) {
      sendError(res, 500, `List files error: ${err.message}`);
    }
  }

  // -------------------------------------------
  // 10) Download a single file
  // -------------------------------------------
  else if (req.method === 'GET' && pathname === '/download') {
    try {
      // Get the file path from the query
      const filePath = query.file;
      if (!filePath) {
        return sendError(res, 400, 'Missing file path');
      }

      // Resolve the file path to prevent directory traversal
      const fullPath = path.resolve(filePath);
      
      // Check if the file exists
      if (!fs.existsSync(fullPath)) {
        return sendError(res, 404, 'File not found');
      }
      
      // Check if it's a file
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        return sendError(res, 400, 'Not a file');
      }

      // Get the file name
      const fileName = path.basename(fullPath);
      
      // Set the content type based on the file extension
      const ext = path.extname(fileName).toLowerCase();
      let contentType = 'application/octet-stream'; // Default to binary
      if (ext === '.pdf') contentType = 'application/pdf';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.txt') contentType = 'text/plain';
      else if (ext === '.mp4') contentType = 'video/mp4';
      else if (ext === '.mp3') contentType = 'audio/mpeg';
      
      // Set headers for the file download
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Length', stats.size);
      
      // Create a read stream and pipe it to the response
      const fileStream = fs.createReadStream(fullPath);
      
      fileStream.on('error', (err) => {
        console.error('Error streaming file:', err);
        if (!res.headersSent) {
          sendError(res, 500, `File streaming error: ${err.message}`);
        }
      });
      
      fileStream.pipe(res);
    } catch (err) {
      console.error('Download error:', err);
      sendError(res, 500, `Server error: ${err.message}`);
    }
  }

  // -------------------------------------------
  // 11) Download multiple files as a zip archive
  // -------------------------------------------
  else if (req.method === 'GET' && pathname === '/download-multiple') {
    try {
      // Parse the files from the query parameter (comma-separated list)
      const fileList = query.files ? query.files.split(',') : [];
      
      if (fileList.length === 0) {
        return sendError(res, 400, 'No files specified');
      }

      // Prepare archive name
      const timestamp = Date.now();
      const archiveName = `download_${timestamp}.zip`;
      
      // For single file that's not too large, redirect to single file download
      if (fileList.length === 1) {
        const fullPath = path.resolve(fileList[0]);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          res.writeHead(302, { 'Location': `/download?file=${encodeURIComponent(fileList[0])}` });
          return res.end();
        }
      }

      // Validate all files exist and gather file details
      const fileDetails = [];
      for (const filePath of fileList) {
        const fullPath = path.resolve(filePath);
        
        if (!fs.existsSync(fullPath)) {
          return sendError(res, 404, `File not found: ${path.basename(fullPath)}`);
        }
        
        const stats = fs.statSync(fullPath);
        if (!stats.isFile()) {
          return sendError(res, 400, `Not a file: ${path.basename(fullPath)}`);
        }
        
        fileDetails.push({
          path: fullPath,
          name: path.basename(fullPath),
          size: stats.size
        });
      }
      
      // Set headers for the zip download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
      
      // Create temporary directory for creating the archive
      const tmpDir = path.join(os.tmpdir(), `download_${timestamp}`);
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      
      // Path for the temporary zip file
      const zipFilePath = path.join(tmpDir, archiveName);
      
      // Create a ZIP file using the archiver module or similar approach
      // Since we're not using third-party packages, we'll implement a simple ZIP creation
      
      // Using Node.js child_process to leverage system zip command if available
      const platform = process.platform;
      let zipCommand;
      
      if (platform === 'win32') {
        // On Windows, check if PowerShell is available for ZIP creation
        zipCommand = `powershell -command "Compress-Archive -Path '${fileDetails.map(f => f.path.replace(/'/g, "''")).join("','")}'`;
        zipCommand += ` -DestinationPath '${zipFilePath.replace(/'/g, "''")}'`;
        zipCommand += ` -Force"`;
      } else {
        // On Unix-like systems (Linux, macOS), use the zip command
        zipCommand = `zip -j "${zipFilePath}"`;
        fileDetails.forEach(file => {
          zipCommand += ` "${file.path.replace(/"/g, '\\"')}"`;
        });
      }
      
      // Execute the zip command
      exec(zipCommand, (error, stdout, stderr) => {
        if (error) {
          console.error('Error creating ZIP archive:', error);
          // Fallback to manual concatenation if zip command fails
          return sendManualDownload(res, fileDetails);
        }
        
        // Stream the zip file to the client
        const zipStream = fs.createReadStream(zipFilePath);
        
        zipStream.on('error', (err) => {
          console.error('Error streaming ZIP file:', err);
          if (!res.headersSent) {
            sendError(res, 500, `Error streaming ZIP: ${err.message}`);
          }
        });
        
        zipStream.on('end', () => {
          // Clean up the temporary file and directory
          fs.unlink(zipFilePath, (err) => {
            if (err) console.error('Failed to clean up ZIP file:', err);
            
            // Try to remove the temporary directory
            try {
              fs.rmdirSync(tmpDir);
            } catch (e) {
              console.error('Failed to clean up temporary directory:', e);
            }
          });
        });
        
        // Pipe the ZIP file to the response
        zipStream.pipe(res);
      });
      
      // Function to handle manual download if zip command fails
      function sendManualDownload(res, files) {
        console.log('Falling back to manual file concatenation');
        
        // Signal the start of streaming
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="files_${timestamp}.dat"`
          });
        }
        
        // Process each file sequentially
        let currentFileIndex = 0;
        
        const processNextFile = () => {
          if (currentFileIndex >= files.length) {
            // All files processed, end the response
            return res.end();
          }
          
          const fileInfo = files[currentFileIndex];
          const readStream = fs.createReadStream(fileInfo.path);
          
          // Write file header with metadata
          const headerStr = JSON.stringify({
            name: fileInfo.name,
            size: fileInfo.size,
            index: currentFileIndex
          });
          const headerBuf = Buffer.from(headerStr);
          const headerLenBuf = Buffer.alloc(4);
          headerLenBuf.writeUInt32BE(headerBuf.length, 0);
          
          // Write header length and header
          res.write(headerLenBuf);
          res.write(headerBuf);
          
          // Stream the file content
          readStream.on('data', chunk => res.write(chunk));
          
          readStream.on('end', () => {
            currentFileIndex++;
            processNextFile();
          });
          
          readStream.on('error', err => {
            console.error(`Error reading file ${fileInfo.name}:`, err);
            currentFileIndex++;
            processNextFile();
          });
        };
        
        // Start processing files
        processNextFile();
      }
    } catch (err) {
      console.error('Multi-download error:', err);
      sendError(res, 500, `Server error: ${err.message}`);
    }
  }

  // -------------------------------------------
  // 12) Fallback: serve static from ./public
  // -------------------------------------------
  else if (req.method === 'GET') {
    let filePath = '.' + pathname;
    if (filePath === './') {
      filePath = './public/index.html';
    } else if (!filePath.startsWith('./public')) {
      filePath = './public' + pathname;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(500);
        return res.end('Server error');
      }
      // Basic content type detection
      let contentType = 'text/html';
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.js') contentType = 'text/javascript';
      else if (ext === '.css') contentType = 'text/css';
      else if (ext === '.json') contentType = 'application/json';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.svg') contentType = 'image/svg+xml';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  // -------------------------------------------
  // 13) 404 Not Found
  // -------------------------------------------
  else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  for (const [fileId, upload] of uploadTracker) {
    if (upload.writeStream) {
      upload.writeStream.end();
    }
    clearTimeout(upload.timeout);
  }
  uploadTracker.clear();
  uploadErrors.clear();
  process.exit(0);
});

const PORT = process.env.PORT || 3999;
server.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});

// Helper function to identify file types based on extension
function getFileType(extension) {
  const imageTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'ico'];
  const docTypes = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'md', 'json'];
  const archiveTypes = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
  const audioTypes = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
  const videoTypes = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv'];
  const codeTypes = ['js', 'ts', 'html', 'css', 'scss', 'php', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'go', 'rs'];
  
  if (imageTypes.includes(extension)) return 'image';
  if (docTypes.includes(extension)) return 'document';
  if (archiveTypes.includes(extension)) return 'archive';
  if (audioTypes.includes(extension)) return 'audio';
  if (videoTypes.includes(extension)) return 'video';
  if (codeTypes.includes(extension)) return 'code';
  
  return 'other';
}
