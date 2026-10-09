// Disposable lab only. No real camera or production credentials.
const net = require('node:net');
const http = require('node:http');
for (const port of [5540, 12345]) net.createServer(client => {
  const upstream = net.connect(8554, 'mediamtx');
  client.pipe(upstream).pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
}).listen(port, '0.0.0.0');
http.createServer((_req, res) => { res.end('This is HTTP, not video.'); }).listen(554, '0.0.0.0');
net.createServer(socket => {
  socket.on('error', () => {});
  socket.on('data', data => {
    const cseq = data.toString().match(/CSeq:\s*(\d+)/i)?.[1] || '1';
    socket.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Digest realm="lab", nonce="labnonce"\r\n\r\n`);
  });
}).listen(9554, '0.0.0.0');
http.createServer((req, res) => {
  let body = '';
  req.on('data', data => { body += data; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/soap+xml');
    const payload = body.includes('GetStreamUri')
      ? '<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://192.168.99.99:12345/fixture-healthy</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>'
      : '<trt:GetProfilesResponse><trt:Profiles token="lab"><tt:Name>Lab</tt:Name><tt:Width>640</tt:Width><tt:Height>360</tt:Height></trt:Profiles></trt:GetProfilesResponse>';
    res.end(`<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><soap:Body>${payload}</soap:Body></soap:Envelope>`);
  });
}).listen(8000, '0.0.0.0');
