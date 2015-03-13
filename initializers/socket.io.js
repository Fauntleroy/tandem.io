var socket_io = require('socket.io');
var _ = require('underscore');

var http_server = require('./http_server.js');
var generateAuthToken = require('../utils/generateAuthToken.js');

var io = socket_io.listen( http_server );

// Socket.io configuration
io.use( function( socket, next ){
	var auth_data = _.pick( socket.request._query, 'id', 'name', 'avatar', 'token' );
	var is_authentic = ( generateAuthToken( auth_data.id, auth_data.name, auth_data.avatar ) === auth_data.token );
	if( !is_authentic ){
		next( new Error('Invalid user token') );
		return;
	}
	socket.auth_data = auth_data;
	next();
});

return io;

module.exports = io;