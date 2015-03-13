const NO_OP = function(){};

var Waterline = require('waterline');
var _ = require('underscore');
var uuid = require('node-uuid');

var io = require('../../initializers/socket.io.js');
var generateRoomName = require('../../utils/generateRoomName');

var Room = Waterline.Collection.extend({
	identity: 'room',
	connection: 'mysql',
	attributes: {
		name: {
			type: 'string',
			size: 60
		},
		player_order: {
			type: 'string',
			enum: ['fifo', 'shuffle'],
			defaultsTo: 'fifo'
		},
		player_likers: {
			type: 'json',
			defaultsTo: []
		},
		player_item: {
			type: 'json'
		},
		playlist: {
			type: 'json',
			defaultsTo: []
		},

		// instance methods
		// ensure the room is up and running
		initializeRoom: function( config ){
			var namespace = this.namespace = '/rooms/'+ this.id;
			// listen for user connections
			io.of( namespace ).on( 'connection', function( socket ){
				var sid = socket.id;
				var auth_data = _.pick( socket.request._query, 'id', 'name', 'avatar', 'token' );
				var id = auth_data.id;
				var name = auth_data.name;
				var avatar = auth_data.avatar;
				var token = auth_data.token;
				var user = {
					id: id,
					name: name,
					avatar: avatar
				};

				// send current presence list
				socket.emit( 'presences:list', room.users );
				// add connection to presences
				var presence = {
					id: id,
					name: name,
					avatar: avatar,
					sid: sid
				};
				room.addPresence( presence );
				socket.on( 'disconnect', function(){
					room.removePresence( presence );
				});

				// send existing playlist
				socket.emit( 'playlist:list', room.playlist );
				// send existing player
				socket.emit( 'player:state', {
					likers: room.player_likers,
					order: room.player_order,
					item: room.player_item
				});

				// listen for commands from the user
				socket.on( 'chat:message', function( content ){
					var message = {
						content: content,
						user: user
					};
					io.of( namespace ).emit( 'chat:message', message );
				});
				socket.on( 'chat:emote', function( content ){
					var message = {
						content: content,
						user: user
					};
					io.of( namespace ).emit( 'chat:emote', message );
				});
				socket.on( 'playlist:add', function( item, callback ){
					callback = callback || NO_OP;
					item.user = user;
					room.addItem( item, function( err ){
						callback( null );
					});
				});
				socket.on( 'playlist:remove', function( id, callback ){
					callback = callback || NO_OP;
					room.removeItem( id, function( err ){
						callback( null );
					});
				});
				socket.on( 'player:skip', function(){
					room.nextItem( user );
				});
				socket.on( 'player:like', function(){
					room.likeItem( user );
				});
				socket.on( 'player:order', function( order ){
					room.setOrder( order );
				});
			});
		},
		// add a user to the users list
		addPresence: function( user ){
			var sessions;
			// check to see if id exists
			var existing_user = _.find( this._users, function( user ){
				return user.id === presence.id;
			});
			// if id exists, add sid to sids array
			if( existing_user ){
				existing_user.sids.push( presence.sid );
			}
			// if id does not exist, add new user to users array
			else {
				this._users.push({
					id: presence.id,
					name: presence.name,
					avatar: presence.avatar,
					sids: [ presence.sid ]
				});
				io.of( this.namespace ).emit( 'presences:join', presence );
			}
		},
		// remove a user from the users list
		removePresence: function( user ){
			// find user with id
			var existing_user = _.find( this._users, function( user ){
				return user.id === presence.id;
			});
			if( !existing_user ) return new Error('No user '+ presence.id );
			// remove sid
			existing_user.sids = _.without( existing_user.sids, presence.sid );
			// if sids.length === 0 remove user from users array
			if( existing_user.sids.length === 0 ){
				this._users = _.without( this._users, existing_user );
				io.of( this.namespace ).emit( 'presences:leave', presence );
			}
		},
		addItem: function( item, cb ){
			cb = cb || NO_OP;
			var room = this;
			item.id = uuid.v4();
			this.playlist.push( item );
			this.save( function( err ){
				io.of( room.namespace ).emit( 'playlist:add', item );
				if( !room.player_item ){
					room.nextItem();
				}
				cb( err );
			});
		},
		removeItem: function( item, cb ){
			cb = cb || NO_OP;
			var room = this;
			var item = _.findWhere( this.playlist, { id: id } );
			this.playlist = _.without( this.playlist, item );
			this.save( function( err ){
				io.of( room.namespace ).emit( 'playlist:remove', item );
				cb( err );
			});
		},
		playItem: function( item, cb ){
			cb = cb || NO_OP;
			var room = this;
			this.player_likers = [];
			// clear player if we're playing nothing
			this.player_item = item;
			this.save( function( err ){
				io.of( room.namespace ).emit( 'player:play', item );
				cb( err );
			});
		},
		likeItem: function( user, cb ){
			cb = cb || NO_OP;
			var room = this;
			var current_item = this.player_item;
			if( !current_item ) return new Error('No item in player');
			var likers = this.player_likers;
			var already_liked = !!_.findWhere( likers, { id: user.id } );
			if( already_liked ) return new Error('User already liked item');
			likers.push( user );
			this.save( function( err ){
				io.of( room.namespace ).emit( 'player:like', {
					user: user,
					message: likeMessage(),
					likers: likers
				});
				cb( err );
			});
		},
		nextItem: function( user, cb ){
			cb = cb || NO_OP;
			var room = this;
			var current_item = this.player_item;
			var next_item;
			switch( this.player_order ){
				case 'fifo':
					next_item = this.playlist[0];
				break;
				case 'shuffle':
					next_item = _.sample( this.playlist );
				break;
			}
			if( next_item ){
				this.removeItem( next_item.id );
			}
			this.playItem( next_item, function( err ){
				if( user ){
					io.of( room.namespace ).emit( 'player:skip', {
						item: current_item,
						user: user
					});
				}
				cb( err );
			});
		},
		checkCurrentItem: function( user, cb ){

		},
		setOrder: function( order, cb ){
			cb = cb || NO_OP;
			order = order || 'fifo';
			var room = this;
			this.player_order = order;
			this.save( function( err ){
				io.of( room.namespace ).emit( 'player:order', order );
				cb( err, order );
			});
		}
	},

	//// lifecycle events
	beforeCreate: function( values, next ){
		values.name = values.name || generateRoomName();
		next();
	},

	//// class methods
	// list rooms
	list: function( cb ){
		cb = cb || NO_OP;
		this
		.find()
		.limit(50)
		.exec( cb );
	}
});

module.exports = Room;