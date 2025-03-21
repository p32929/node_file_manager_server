const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('url');

const server = http.createServer((req, res) => {
  const { pathname, query } = parse(req.url, true);
  const method = req.method;

  if (method === 'GET' && pathname === '/') {
    fs.readFile('./public/index.html', (err, data) => {
      if (err) return res.end('Error loading HTML');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }

  else if (method === 'GET' && pathname === '/list-folders') {
    let currentPath = query.path || '/';
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

  else if (method === 'POST' && pathname === '/upload') {
    const boundary = req.headers['content-type'].split('boundary=')[1];
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

  else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(3000, () => console.log('http://localhost:3000'));
