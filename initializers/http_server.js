var http = require('http');

var express_server = require('./express.js');
console.log('e s',express_server);
var http_server = http.createServer( express_server );

module.exports = http_server;