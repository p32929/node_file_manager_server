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

const server = http.createServer((req, res) => {
  // Set CORS headers for cross-tab uploads
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Path, Content-Disposition, Content-Range');
  
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
      // Extract metadata from headers
      const fileName = req.headers['x-file-name'];
      const chunkIndex = parseInt(req.headers['x-chunk-index']);
      const totalChunks = parseInt(req.headers['x-total-chunks']);
      const targetPath = req.headers['x-file-path'] || getCurrentPath();
      
      if (!fileName || isNaN(chunkIndex) || isNaN(totalChunks)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Missing or invalid headers' }));
      }
      
      // Create unique ID based on filename and total chunks
      const fileId = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const chunkDir = path.join(TEMP_DIR, fileId);
      
      // Create directory for this file's chunks if it doesn't exist
      if (chunkIndex === 0 && fs.existsSync(chunkDir)) {
        fs.rmSync(chunkDir, { recursive: true, force: true });
      }
      
      if (!fs.existsSync(chunkDir)) {
        fs.mkdirSync(chunkDir, { recursive: true });
      }
      
      // Write chunk to temporary file
      const chunkFilePath = path.join(chunkDir, `chunk-${chunkIndex}`);
      
      // Get raw body data
      let data = [];
      req.on('data', chunk => {
        data.push(chunk);
      });
      
      req.on('end', () => {
        const buffer = Buffer.concat(data);
        
        // Write chunk to disk
        fs.writeFileSync(chunkFilePath, buffer);
        
        // Check if this was the last chunk
        const files = fs.readdirSync(chunkDir).filter(file => file.startsWith('chunk-'));
        
        if (files.length === totalChunks) {
          // All chunks received, combine them
          const outputDir = path.resolve(targetPath);
          
          // Create upload directory if it doesn't exist
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          
          const finalFilePath = path.join(outputDir, fileName);
          const writeStream = fs.createWriteStream(finalFilePath);
          
          // Combine all chunks in order
          for (let i = 0; i < totalChunks; i++) {
            const chunkPath = path.join(chunkDir, `chunk-${i}`);
            if (fs.existsSync(chunkPath)) {
              const chunkData = fs.readFileSync(chunkPath);
              writeStream.write(chunkData);
            } else {
              console.error(`Missing chunk ${i} for file ${fileName}`);
            }
          }
          
          writeStream.end();
          
          // Clean up temporary files
          setTimeout(() => {
            try {
              fs.rmSync(chunkDir, { recursive: true, force: true });
            } catch (error) {
              console.error('Error cleaning up chunks:', error);
            }
          }, 1000);
          
          res.writeHead(200);
          res.end('File upload complete');
        } else {
          // More chunks expected
          res.writeHead(200);
          res.end('Chunk received');
        }
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
          res.end(`Server error: ${err.code}`);
        }
        return;
      }
      
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }
  
  // 404 Not Found for any other requests
  else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Helper function to get current path
function getCurrentPath() {
  return process.cwd();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
