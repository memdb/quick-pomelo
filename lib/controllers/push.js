'use strict';

var Q = require('q');
var logger = require('pomelo-logger').getLogger('push', __filename);

// Msgs keep in history
var DEFAULT_MAX_MSG_COUNT = 100;

var Controller = function(app){
	this.app = app;

	var opts = app.get('pushConfig') || {};
	this.maxMsgCount = opts.maxMsgCount || DEFAULT_MAX_MSG_COUNT;
};

var proto = Controller.prototype;

/**
 * ChannelIds:
 *
 * a:areaId - channel for an area
 * t:teamId - channel for a team
 * p:playerId - channel for a player
 * g:groupId - channel for a discussion group
 */

/**
 * player join a channel
 * auto create new channels
 */
proto.join = function(channelId, playerId, connectorId){
	var models = this.app.models;

	if(!connectorId){
		connectorId = '';
	}
	var self = this;
	return Q.fcall(function(){
		return Q.fcall(function(){
			return models.Channel.findForUpdateQ(channelId);
		})
		.then(function(channel){
			if(!channel){
				channel = new models.Channel({_id : channelId});
				logger.info('create channel %s', channelId);
			}
			channel.players[playerId] = connectorId;
			channel.markModified('players');
			return channel.saveQ();
		});
	})
	.then(function(ret){
		return Q.fcall(function(){
			return models.PlayerChannel.findForUpdateQ(playerId);
		})
		.then(function(playerChannel){
			if(!playerChannel){
				playerChannel = new models.PlayerChannel({_id : playerId});
			}
			playerChannel.channels[channelId] = true;
			playerChannel.markModified('channels');
			return playerChannel.saveQ();
		});
	})
	.then(function(){
		logger.info('join %j', [channelId, playerId, connectorId]);
	});
};

/**
 * player quit a channel
 * auto remove empty channels
 */
proto.quit = function(channelId, playerId){
	var models = this.app.models;

	var self = this;
	return Q.fcall(function(){
		return Q.fcall(function(){
			return models.Channel.findForUpdateQ(channelId);
		})
		.then(function(channel){
			if(!channel){
				throw new Error('channel ' + channelId + ' not exist');
			}
			delete channel.players[playerId];
			channel.markModified('players');

			if(Object.keys(channel.players).length === 0){
				logger.info('remove channel %s', channelId);
				return channel.removeQ();
			}
			else{
				return channel.saveQ();
			}
		});
	})
	.then(function(ret){
		return Q.fcall(function(){
			return models.PlayerChannel.findForUpdateQ(playerId);
		})
		.then(function(playerChannel){
			if(!playerChannel){
				throw new Error('playerChannel ' + playerId + ' not exist');
			}
			delete playerChannel.channels[channelId];
			playerChannel.markModified('channels');

			if(Object.keys(playerChannel.channels).length === 0){
				return playerChannel.removeQ();
			}
			else{
				return playerChannel.saveQ();
			}
		});
	})
	.then(function(){
		logger.info('quit %j', [channelId, playerId]);
	});
};

proto.connect = function(playerId, connectorId){
	if(!connectorId){
		connectorId = '';
	}
	var models = this.app.models;

	var self = this;
	return Q.fcall(function(){
		return models.PlayerChannel.findForUpdateQ(playerId);
	})
	.then(function(playerChannel){
		if(!playerChannel){
			return;
		}
		return Q.all(Object.keys(playerChannel.channels).map(function(channelId){
			return Q.fcall(function(){
				return models.Channel.findForUpdateQ(channelId);
			})
			.then(function(channel){
				if(!channel){
					throw new Error('channel ' + channelId + ' not exist');
				}
				channel.players[playerId] = connectorId;
				channel.markModified('players');
				return channel.saveQ();
			});
		}));
	})
	.then(function(){
		logger.info('connect %j', [playerId, connectorId]);
	});
};

proto.disconnect = function(playerId){
	var models = this.app.models;
	var self = this;
	return Q.fcall(function(){
		return models.PlayerChannel.findForUpdateQ(playerId);
	})
	.then(function(playerChannel){
		if(!playerChannel){
			return;
		}
		return Q.all(Object.keys(playerChannel.channels).map(function(channelId){
			return Q.fcall(function(){
				return models.Channel.findForUpdateQ(channelId);
			})
			.then(function(channel){
				if(!channel){
					throw new Error('channel ' + channelId + ' not exist');
				}
				channel.players[playerId] = '';
				channel.markModified('players');
				return channel.saveQ();
			});
		}));
	})
	.then(function(){
		logger.info('disconnect %j', [playerId]);
	});
};

proto.push = function(channelId, playerIds, route, msg, persistent){
	var args = [].slice.call(arguments);
	var self = this;
	return Q.fcall(function(){
		return self.app.models.Channel.findForUpdateQ(channelId);
	})
	.then(function(channel){
		if(!channel){
			throw new Error('channel ' + channelId + ' not exist');
		}
		var seq = channel.seq;

		var pushMsg = {msg : msg, route : route};
		if(persistent){
			pushMsg.seq = seq;
		}

		if(persistent){
			channel.msgs.push(pushMsg);
			channel.seq++;
			if(channel.msgs.length > self.maxMsgCount){
				channel.msgs = channel.msgs.slice(self.maxMsgCount / 2);
			}
			channel.markModified('msgs');
		}

		var connectorUids = {};
		if(!!playerIds){
			if(persistent){
				throw new Error('can not send persistent message to specific players');
			}
			playerIds.forEach(function(playerId){
				if(channel.players.hasOwnProperty(playerId)){
					var connectorId = channel.players[playerId];
					if(!!connectorId){
						if(!connectorUids[connectorId]){
							connectorUids[connectorId] = [];
						}
						connectorUids[connectorId].push(playerId);
					}
				}
			});
		}
		else{
			for(var playerId in channel.players){
				var connectorId = channel.players[playerId];
				if(!!connectorId){
					if(!connectorUids[connectorId]){
						connectorUids[connectorId] = [];
					}
					connectorUids[connectorId].push(playerId);
				}
			}
		}

		return Q.fcall(function(){
			return channel.saveQ();
		})
		.then(function(){
			return self.pushToConnectors(connectorUids, route, pushMsg);
		});
	})
	.then(function(){
		logger.info('push %j', args);
	});
};

proto.pushToConnectors = function(connectorUids, route, msg){
	var self = this;
	return Q.all(Object.keys(connectorUids).map(function(connectorId){
		var uids = connectorUids[connectorId];
		return Q.nfcall(function(cb){
			var opts = {type : 'push', userOptions: {}, isPush : true};
			self.app.rpcInvoke(connectorId, {
				namespace : 'sys',
				service : 'channelRemote',
				method : 'pushMessage',
				args : [route, msg, uids, opts]
			}, cb);
		})
		.catch(function(e){
			logger.warn(e);
		});
	}))
	.then(function(){
		logger.info('pushToConnectors %j %j %j', connectorUids, route, msg);
	});
};

proto.getMsgs = function(channelId, seq, count){
	var self = this;
	if(!seq){
		seq = 0;
	}
	if(!count){
		count = this.maxMsgCount;
	}
	return Q.fcall(function(){
		return self.app.models.Channel.findQ(channelId);
	})
	.then(function(channel){
		if(!channel){
			throw new Error('channel ' + channelId + ' not exist');
		}
		var start = seq - channel.seq + channel.msgs.length, end = start + count;
		if(start < 0){
			start = 0;
		}
		if(end < 0){
			end = 0;
		}
		var msgs = channel.msgs.slice(start, end);

		logger.info('getMsgs %j => %j', [channelId, seq, count], msgs);
		return msgs;
	});
};

module.exports = function(app){
	return new Controller(app);
};