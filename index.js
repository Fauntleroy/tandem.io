if( process.env.NEW_RELIC_LICENSE_KEY ){
	require('newrelic');
}

const PORT = process.env.PORT || 8080;
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3';
const MYSQL_URL = process.env.TANDEM_MYSQL_URL || process.env.CLEARDB_DATABASE_URL;
const ENV = process.env.NODE_ENV || 'development';

var express_server = require('./initializers/express.js');
var http_server = require('./initializers/http_server.js');

var url = require('url');

// parse my own connection details because waterline is broken
var parsed_mysql_connection_url = url.parse( MYSQL_URL );

// Database
var Waterline = require('waterline');
var waterline_mysql_adapter = require('sails-mysql');
var User = require('./db/models/user.js');
var Room = require('./db/models/room.js');
var waterline_orm = new Waterline();
waterline_orm.loadCollection( User );
waterline_orm.loadCollection( Room );
waterline_orm.initialize({
	adapters: {
		default: waterline_mysql_adapter,
		mysql: waterline_mysql_adapter
	},
	connections: {
		mysql: {
			adapter: 'mysql',
			host: parsed_mysql_connection_url.hostname,
			port: parsed_mysql_connection_url.port,
			user: parsed_mysql_connection_url.auth.split(':')[0],
			password: parsed_mysql_connection_url.auth.split(':')[1],
			database: parsed_mysql_connection_url.pathname.substring(1)
		}
	},
	defaults: {
		migrate: 'alter'
	}
}, function( err, models ){
	if( err ){
		// throwing this error just gets you misery
		console.log( err );
	}
	express_server.models = models.collections;
	express_server.connections = models.connections;
});

http_server.listen( PORT );

console.log('[tandem] listening on port', PORT );
