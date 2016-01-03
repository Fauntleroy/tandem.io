// Environment variables
const env = require('./utils/environment');

const PORT = env( 'PORT', { default: 8080, transform: parseInt } );
const ENV = env( 'NODE_ENV', { default: 'development' } );
const URL = env( 'TANDEM_URL', { default: 'http://dev.tandem.io:8080' } );
const SESSION_SECRET = env( 'TANDEM_SESSION_SECRET', { required: true } );
const MYSQL_URL = env( ['TANDEM_MYSQL_URL', 'CLEARDB_DATABASE_URL'], { required: true } );
const REDIS_URL = env( ['TANDEM_REDIS_URL', 'REDISTOGO_URL'], { default: 'redis://localhost' } );
const SOUNDCLOUD_APP_ID = env( 'TANDEM_SOUNDCLOUD_APP_ID', { required: true } );
const SOUNDCLOUD_APP_SECRET = env( 'TANDEM_SOUNDCLOUD_APP_SECRET', { required: true } );
const YOUTUBE_APP_ID = env( 'TANDEM_YOUTUBE_APP_ID', { required: true } );
const YOUTUBE_APP_SECRET = env( 'TANDEM_YOUTUBE_APP_SECRET', { required: true } );
const YOUTUBE_API_KEY = env( 'TANDEM_YOUTUBE_API_KEY', { required: true } );

// Consts
const SOUNDCLOUD_API_BASE_URL = 'https://api.soundcloud.com';
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3';
const VIEWS_PATH = __dirname +'/views';
const NO_OP = function(){};

// General 3rd party dependencies
var http = require('http');
var socket_io = require('socket.io');
var async = require('async');
var _ = require('underscore');
var url = require('url');
var request = require('request');
var express = require('express');
var expose = require('express-expose');

// Server
var server = express();
expose(server);
var http_server = http.createServer( server );
var io = socket_io.listen( http_server );

var generateAuthToken = require('./utils/generateAuthToken.js');
var Room = require('./models/room.js')({ io: io });

// Parse the connection details because waterline is broken
var parsed_mysql_connection_url = url.parse( MYSQL_URL );

// Database
var Waterline = require('waterline');
var waterline_mysql_adapter = require('sails-mysql');
var User = require('./db/models/user.js');
var waterline_orm = new Waterline();
waterline_orm.loadCollection( User );
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
		migrate: 'safe'
	}
}, function( err, models ){
	if( err ){
		// throwing this error just gets you misery
		console.log( err );
	}
	server.models = models.collections;
	server.connections = models.connections;
});

// Set up templates for Express
var express_handlebars = require('express-hbs');
var handlebars = express_handlebars.express3({
	extname: '.hbs',
	defaultLayout: VIEWS_PATH +'/layouts/main.hbs',
	partialsDir: VIEWS_PATH +'/partials',
	layoutsDir: VIEWS_PATH +'/layouts'
});
server.engine( 'hbs', handlebars );
server.set( 'view engine', 'hbs' );
server.set( 'views', VIEWS_PATH );

// Sessions
var express_session = require('express-session');
var RedisStore = require('connect-redis')( express_session );
var parsed_redis_connection_url = url.parse( REDIS_URL );
server.use( express.cookieParser() );
server.use( express.bodyParser() );
server.use( express_session({
	secret: SESSION_SECRET,
	cookie: {
		maxAge: 1000 * 60 * 60 * 24 * 14 // 2 weeks from now
	},
	store: new RedisStore({
		host: parsed_redis_connection_url.hostname,
		port: parsed_redis_connection_url.port,
		pass: (parsed_redis_connection_url.auth || '').split(':')[1]
	}),
	resave: false,
	saveUninitialized: true
}) );

// Compress responses
server.use( express.compress() );

// Static file serving
server.use( express.static( __dirname + '/assets' ) );

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

// Pass environment to views
server.locals.dev = ( ENV === 'development' );

// Passport stuff
var passport = require('passport');
var guestSetup = require('./middleware/guest.js');

server.use( passport.initialize() );
server.use( passport.session() );
server.use( guestSetup );

// Routing comes last
server.use( server.router );

passport.serializeUser( function( user, done ){
	done( null, user );
});

passport.deserializeUser( function( obj, done ){
	done( null, obj );
});

// Soundcloud login
var passport_soundcloud = require('passport-soundcloud');
var SoundcloudStrategy = passport_soundcloud.Strategy;

passport.use( new SoundcloudStrategy({
	clientID: SOUNDCLOUD_APP_ID,
	clientSecret: SOUNDCLOUD_APP_SECRET,
	callbackURL: URL +'/auth/soundcloud/callback',
	passReqToCallback: true
}, function( req, access_token, refresh_token, params, profile, done ){
	var user_session = req.session.passport.user;
	var auth_data = {
		soundcloud_username: profile._json.username,
		soundcloud_avatar: profile._json.avatar_url,
		soundcloud_client_id: profile.id,
		soundcloud_access_token: access_token
	};
	server.models.user.updateOrCreate( auth_data, user_session, function( err, user ){
		if( err ) return done( err, null );
		var user_json = user.toJSON();
		// if we already have a user session, merge them
		if( user_session ){
			user_json = _.extend( user_session, user_json );
		}
		done( null, user_json );
	});
}));

// Youtube login
var passport_google = require('passport-google-oauth');
var GoogleStrategy = passport_google.OAuth2Strategy;

var getLikesID = function( access_token, callback ){
	callback = callback || NO_OP;
	request({
		url: YOUTUBE_API_BASE_URL +'/channels',
		qs: {
			part: 'contentDetails',
			mine: true
		},
		headers: {
			'Authorization': 'Bearer '+ access_token
		},
		method: 'GET',
		json: true
	}, function( err, res, body ){
		callback( err, body.items[0].contentDetails.relatedPlaylists.likes );
	});
};

passport.use( new GoogleStrategy({
	clientID: YOUTUBE_APP_ID,
	clientSecret: YOUTUBE_APP_SECRET,
	callbackURL: URL +'/auth/youtube/callback',
	profileURL: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
	passReqToCallback: true
}, function( req, access_token, refresh_token, params, profile, done ){
	getLikesID( access_token, function( err, likes_id ){
		if( err ) return done( err, null );
		var user_session = _.extend( {}, req.session.passport.user );
		var youtube_access_token_expiry = new Date( Date.now() + ( params.expires_in * 1000 ) );
		var auth_data = {
			youtube_username: profile.displayName,
			youtube_avatar: profile._json.picture,
			youtube_client_id: profile.id,
			youtube_access_token: access_token,
			youtube_access_token_expiry: youtube_access_token_expiry,
			youtube_refresh_token: refresh_token,
			youtube_likes_id: likes_id
		};
		server.models.user.updateOrCreate( auth_data, user_session, function( err, user ){
			if( err ) return done( err, null );
			var user_json = user.toJSON();
			// if we already have a user session, merge them
			if( user_session ){
				user_json = _.extend( user_session, user_json );
			}
			done( null, user_json );
		});
	});
}));

// Routes
server.get( '/auth/soundcloud',	passport.authenticate( 'soundcloud', {
	scope: 'non-expiring'
}));

server.get( '/auth/soundcloud/callback', passport.authenticate( 'soundcloud', {
	successRedirect: '/',
	failureRedirect: '/?err=soundcloud-login-failed'
}));

server.get( '/auth/soundcloud/unlink', function( req, res ){
	if( !req.user.soundcloud_client_id ) res.redirect('/');
	server.models.user
	.findOne()
	.where({ id: req.user.id })
	.exec(function( err, user ){
		user.removeAuth( 'soundcloud', function(){
			req.user.soundcloud_client_id = null;
			req.user.soundcloud_access_token = null;
			res.redirect('/');
		});
	});
});

server.get( '/auth/youtube', passport.authenticate( 'google', {
	scope: 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
	accessType: 'offline',
	approvalPrompt: 'force'
}));

server.get( '/auth/youtube/unlink', function( req, res ){
	if( !req.user.youtube_client_id ) res.redirect('/');
	server.models.user
	.findOne()
	.where({ id: req.user.id })
	.exec(function( err, user ){
		user.removeAuth( 'youtube', function(){
			req.user.youtube_client_id = null;
			req.user.youtube_access_token = null;
			req.user.youtube_refresh_token = null;
			req.user.youtube_access_token_expiry = null;
			req.user.youtube_likes_id = null;
			res.redirect('/');
		});
	});
});

server.get( '/auth/youtube/callback', passport.authenticate( 'google', {
	successRedirect: '/',
	failureRedirect: '/?err=youtube-login-failed'
}));

server.post( '/api/v1/rooms', function( req, res ){
	var room = new Room;
	room.save( function( err, room ){
		res.json( room );
	});
});

server.get( '/api/v1/rooms/:id?', function( req, res ){
	if( req.params.id ){
		Room.findById( req.params.id, function( err, room ){
			res.json( room );
		});
	}
	else {
		Room.find( function( err, rooms ){
			res.json( rooms );
		});
	}
});

server.put( '/api/v1/rooms/:id', function( req, res ){
	var new_data = _.omit( req.body, '_id' );
	Room.findByIdAndUpdate( req.params.id, new_data, function( err, room ){
		res.json( room );
	});
});

server.delete( '/api/v1/rooms/:id', function( req, res ){
	Room.findByIdAndRemove( req.params.id, function( err, room ){
		res.json( room );
	});
});

server.all( /^\/api\/v1\/proxy\/soundcloud\/(.+)$/, function( req, res ){
	if( !req.user.soundcloud_client_id ) return res.json( 500, { error: 'Error: User has no SoundCloud credentials' });
	if( !req.user.soundcloud_access_token ) return res.json( 500, { error: 'Error: Missing access token' });
	var query = _.extend( req.query, {
		oauth_token: req.user.soundcloud_access_token
	});
	var endpoint = req.params[0];
	request({
		url: SOUNDCLOUD_API_BASE_URL +'/'+ endpoint,
		qs: query,
		method: req.method
	}).pipe( res );
});

// use refresh_token to get a new access_token
var refreshYouTubeToken = function( refresh_token, cb ){
	request({
		url: 'https://accounts.google.com/o/oauth2/token',
		form: {
			client_id: YOUTUBE_APP_ID,
			client_secret: YOUTUBE_APP_SECRET,
			refresh_token: refresh_token,
			grant_type: 'refresh_token'
		},
		method: 'POST'
	}, function( err, res, body ){
		if( err ) return cb( err, null );
		body = JSON.parse( body );
		if( body.error ) return cb( new Error( body.error +' '+ body.error_description ), null );
		cb( null, body.access_token, body.expires_in );
	});
};

server.all( /^\/api\/v1\/proxy\/youtube\/(.+)$/, function( req, res ){
	if( !req.user.youtube_client_id ){
		res.json( 500, { error: 'Error: User has no YouTube credentials' });
		return;
	}
	if( !req.user.youtube_access_token ){
		res.json( 500, { error: 'Error: Missing access token' });
		return;
	}
	async.waterfall([ function checkToken( next ){
		if( Date.now() > new Date(req.user.youtube_access_token_expiry) ){
			refreshYouTubeToken( req.user.youtube_refresh_token, function( err, access_token, expires_in ){
				if( err ) return next( err, null );
				req.user.youtube_access_token = access_token;
				req.user.youtube_access_token_expiry = new Date( Date.now() + ( expires_in * 1000 ) );
				next( null, access_token );
			});
		}
		else {
			next( null, req.user.youtube_access_token );
		}
	}, function makeRequest( access_token, next ){
		var query = _.extend( req.query, {
			key: YOUTUBE_API_KEY
		});
		var endpoint = req.params[0];
		var proxied_request = request({
			url: YOUTUBE_API_BASE_URL +'/'+ endpoint,
			qs: query,
			json: !_.isEmpty( req.body ) ? req.body : null,
			headers: {
				'Authorization': 'Bearer '+ access_token
			},
			method: req.method
		});
		next( null, proxied_request );
	}], function( err, proxied_request ){
		if( err ) return res.json( 500, { error: err.toString() });
		proxied_request.pipe( res );
	});
});

server.get( '/logout', function( req, res ){
	req.logout();
	res.redirect('/');
});

server.post( '/rooms', function( req, res ){
	var private = req.body.private === 'on';
	var room = new Room({
		private: private
	});
	res.redirect( '/rooms/'+ room.id );
});

server.get( '/rooms/:id', function( req, res ){
	var user = req.session.passport.user || {};
	var user_data = _.pick( user, 'id', 'name', 'avatar', 'is_registered', 'is_youtube_linked', 'is_soundcloud_linked', 'youtube_likes_id' );
	user_data.id = user_data.id.toString();
	user_data.token = generateAuthToken( user_data.id, user_data.name, user_data.avatar );
	var room = Room.findById( req.params.id, true );
	res.expose( room, 'tandem.bridge.room' );
	res.expose( user_data, 'tandem.bridge.user' );
	res.expose( {
		soundcloud: {
			client_id: SOUNDCLOUD_APP_ID
		},
		youtube: {
			api_key: YOUTUBE_API_KEY
		}
	}, 'tandem.bridge.apis' );
	res.render( 'room.hbs', {
		room: room,
		user: user_data
	});
});

var renderIndex = function( req, res ){
	var rooms = Room.list({
		convert: true
	});
	res.render( 'index.hbs', {
		rooms: rooms
	});
};

server.get( '/', renderIndex );
server.get( '/rooms/:id', renderIndex );

http_server.listen( PORT );

console.log('[tandem] listening on port', PORT );
