// Referencing modules.
const fs = require('fs-extra');
const app = require('express')();
const server = require('http').Server(app);
const bodyParser = require('body-parser');
const io = require('socket.io')(server);
const needle = require('needle');
const async = require('async');
const WebSocket = require('ws');
const TwitchJS = require('twitch-js');

// Loading config.
var config = fs.readJsonSync('./config.json', {throws: false});
if (!config) {
	console.log('You have forgotten the config.json file; using defaults.');
}

// Set port/key shorthand here; defaults if the config doesn't have it set.
var port = (config) ? config.port : 1234;
var key = (config) ? config.key : 'default_key';

// If we want to store/send information on other streams using this server.
var storeStreamInfo = (config) ? config.storeStreamInfo : false;

// Starting server.
app.use(bodyParser.json());
server.listen(port);
console.log(`Listening on port ${port}.`);

// Storage for stream information to send to clients.
var streamInfo = {
	stream1: null,
	stream2: null
};

var twitchAPItwitchAPIRequestOptions = {
	headers: {
		'Accept': 'application/vnd.twitchtv.v5+json',
		'Content-Type': 'application/json'
	}
};

// If no file with Twitch information in is found, make a blank object.
var twitchTokens = fs.readJsonSync('./twitch_tokens.json', {throws: false});
if (!twitchTokens) {
	twitchTokens = {
		access: '',
		refresh: '',
		name: '',
		id: ''
	};
}

// FFZ storage.
var ffzWSMessageNumber;
var ffzWS;
var ffzWSConnected = false;
var ffzWSPingTimeout;

// Set some stuff in Twitch request options (if available).
twitchAPIRequestOptions.headers['Client-ID'] = config.clientID;
if (twitchTokens.access) twitchAPIRequestOptions.headers['Authorization'] = `OAuth ${twitchTokens.access}`;

// If we have an access token already, check if it's still valid and refresh if needed.
if (twitchTokens.access) {
	console.log('Twitch access token available, checking for validity.');
	checkTwitchTokenValidity(() => {
		console.log('Twitch start up access token validity check done.');
		connectToFFZWS(() => {/* connection to ws done */});
	});
}

// Emit stream information to clients when they connect.
io.on('connection', (socket) => {
	console.log('Client connected with ID %s', socket.id);
	if (storeStreamInfo) socket.emit('streamInfo', streamInfo);
});

// A GET in case you need to check the server is running.
app.get('/', (req, res) => {
	res.send('Running OK');
});

// A GET used to display a link to authorise with Twitch.
app.get('/twitchlogin', (req, res) => {
	var twitchAuthURL = `https://api.twitch.tv/kraken/oauth2/authorize?client_id=${config.clientID}&redirect_uri=${config.redirectURI}&response_type=code&scope=chat:read+chat:edit&force_verify=true`;
	if (twitchTokens.name) res.send(`<a href="${twitchAuthURL}">CLICK HERE TO LOGIN</a><br><br>Account already logged in, only use above link if needed.`);
	else res.send(`<a href="${twitchAuthURL}">CLICK HERE TO LOGIN</a>`);
});

// A GET used by the Twitch redirect that is used to create the tokens.
app.get('/twitchauth', (req, res) => {
	console.log('Someone is trying to authorise with Twitch.');
	res.send('<b>Twitch authentication is now complete, feel free to close this window/tab.</b>');
	if (req.query.error) return;
	
	needle.post('https://api.twitch.tv/kraken/oauth2/token', {
		'client_id': config.clientID,
		'client_secret': config.clientSecret,
		'code': req.query.code,
		'grant_type': 'authorization_code',
		'redirect_uri': config.redirectURI
	}, (err, resp) => {
		twitchTokens.access = resp.body.access_token;
		twitchTokens.refresh = resp.body.refresh_token;

		twitchAPIRequestOptions.headers['Authorization'] = `OAuth ${twitchTokens.access}`;

		console.log('Twitch initial tokens obtained.');
		
		needle.get('https://api.twitch.tv/kraken', twitchAPIRequestOptions, (err, resp) => {
			twitchTokens.id = resp.body.token.user_id;
			twitchTokens.name = resp.body.token.user_name;
			console.log('Twitch user trying to auth is %s.', twitchTokens.name);

			if (twitchTokens.name !== 'esamarathon') return;
			fs.writeJsonSync('./twitch_tokens.json', twitchTokens);
			console.log('Twitch auth successful.');
			connectToFFZWS(() => {/* connection to ws done */});
		});
	});
});

// Having to do a check every time before using the API is sloppy, need to improve flow.
function checkTwitchTokenValidity(callback) {
	var tokenChecked = false;
	async.whilst(
		() => {return !tokenChecked},
		(callback) => {
			needle.get('https://api.twitch.tv/kraken', twitchAPIRequestOptions, (err, resp) => {
				if (err || resp.statusCode !== 200 || !resp || !resp.body) callback();
				else {
					tokenChecked = true;
					callback(null, resp.body);
				}
			});
		},
		(err, body) => {
			// If the OAuth token is valid, we can use it for our requests!
			if (body.token && body.token.valid) {
				if (callback) callback();
			}
			else
				updateTwitchToken(() => {if (callback) callback();});
		}
	);
}

function updateTwitchToken(callback) {
	console.log('Twitch access token being refreshed.');
	var tokenRefreshed = false;
	async.whilst(
		() => {return !tokenRefreshed},
		(callback) => {
			needle.post('https://api.twitch.tv/kraken/oauth2/token', {
				'grant_type': 'refresh_token',
				'refresh_token': encodeURI(twitchTokens.refresh),
				'client_id': config.clientID,
				'client_secret': config.clientSecret
			}, (err, resp) => {
				if (err || resp.statusCode !== 200 || !resp || !resp.body) callback();
				else {
					tokenRefreshed = true;
					callback(null, resp.body);
				}
			});
		},
		(err, body) => {
			twitchTokens.access = body.access_token;
			twitchTokens.refresh = body.refresh_token;
			twitchAPIRequestOptions.headers['Authorization'] = `OAuth ${twitchTokens.access}`;
			fs.writeJsonSync('./twitch_tokens.json', twitchTokens);
			console.log('Twitch access token successfully refreshed.');
			callback();
		}
	);
}

// A POST used to update the featured channels on the Twitch extension and FFZ.
app.post('/featured_channels', (req, res) => {
	// Reject POSTs without the correct key.
	if (req.query.key !== key) {
		res.sendStatus(403);
		return;
	}

	setFFZFollowing(req.body.channels);
	setFeaturedChannelsExt(req.body.channels);
	res.sendStatus(200);
});

// This is where the tracker postbacks are received.
app.post('/tracker', (req, res) => {
	// Reject POSTs without the correct key.
	if (req.query.key !== key) {
		res.sendStatus(403);
		return;
	}
	
	// Donation pushes, from when they are approved to be shown on stream.
	if (req.body.message_type === 'donation_push') {
		// Remove the comment if it wasn't approved.
		if (req.body.comment_state !== 'APPROVED')
			req.body.comment = '';
		
		// Constructing the data to be sent.
		var data = {
			event: req.body.event,
			id: req.body.id,
			donor_visiblename: req.body.donor_visiblename,
			amount: req.body.amount,
			comment_state: req.body.comment_state,
			comment: req.body.comment,
			time_received: req.body.time_received
		};
		
		// Emit this data over the sockets.
		io.emit('donation', data);
		console.log('EMIT donation:', data);
	}
	
	// Donation total change, when the total goes up when a payment is confirmed.
	else if (req.body.message_type === 'donation_total_change') {
		// Constructing the data to be sent.
		var data = {
			event: req.body.event,
			id: req.body.id,
			amount: req.body.amount,
			new_total: req.body.new_total
		};
		
		// Emit this data over the sockets.
		io.emit('total', data);
		console.log('EMIT total:', data);
	}
	
	res.sendStatus(200);
});

// POSTS to here from streams on what their current run is.
if (storeStreamInfo) {
	app.post('/stream_info', (req, res) => {
		// Reject POSTs without the correct key.
		if (req.query.key !== key) {
			res.sendStatus(403);
			return;
		}
		
		// Store the data in the correct place.
		if (req.body.stream === 1)
			streamInfo.stream1 = req.body.runData;
		else if (req.body.stream === 2)
			streamInfo.stream2 = req.body.runData;

		// Emit this information now that it's changed.
		io.emit('streamInfo', streamInfo);
		console.log('EMIT streamInfo:', streamInfo);
		res.sendStatus(200);
	});
}

// POSTS to here from the omnibar moderation tool.
app.post('/omnibar_mod', (req, res) => {
	// Reject POSTs without the correct key.
	if (req.query.key !== key) {
		res.sendStatus(403);
		return;
	}

	// Return a 400 if the body is not supplied.
	if (!req.body) {
		res.sendStatus(400);
		return;
	}

	// Emit this information.
	io.emit('omnibarMod', req.body);
	console.log('EMIT omnibarMod:', req.body);
	res.json({success: true});
});

// GETs to here return the stream information, if needed.
if (storeStreamInfo) {
	app.get('/stream_info', (req, res) => {
		res.json(streamInfo);
	});
}

function connectToFFZWS(callback) {
	// Initial messages to send on connection.
	var messagesToSend = [
		`setuser "${twitchTokens.name}"`,
		`sub "room.${twitchTokens.name}"`,
		`sub "channel.${twitchTokens.name}"`,
		`ready 0`
	];

	// Reset message number and connect.
	ffzWSMessageNumber = 1;
	var serverURL = pickServer();
	ffzWS = new WebSocket(serverURL);
	console.log('Connecting to FrankerFaceZ (%s).', serverURL);

	// Catching any errors with the connection. The "close" event is also fired if it's a disconnect.
	ffzWS.on('error', error => {
		console.log('Error occurred on the FrankerFaceZ connection: %s', error);
	});

	ffzWS.once('open', () => {
		console.log('Connection to FrankerFaceZ successful.');
		ffzWS.send('1 hello ["ESA-Repeater",false]');
	});

	// If we disconnect, just run this function again after a delay to reconnect.
	ffzWS.once('close', () => {
		console.log('Connection to FrankerFaceZ closed, will reconnect in 10 seconds.');
		ffzWSConnected = false;
		clearTimeout(ffzWSPingTimeout);
		setTimeout(connectToFFZWS, 10000);
	});

	ffzWS.once('message', data => {
		if (data.indexOf('1 ok') === 0) {
			ffzWSMessageNumber++;

			// Loop to send all the messages we need on connect.
			var i = 0;
			async.whilst(
				function() {return i < 4;},
				function(callback) {
					sendMessage(messagesToSend[i], message => {
						if (message === 'ok') {i++; callback();}
					});
				},
				function(err) {
					ffzWSConnected = true;
					ffzWSPingTimeout = setTimeout(ping, 60000); // PING every minute
					if (callback) {callback();}
				}
			);
		}
	});

	// For -1 messages.
	ffzWS.on('message', data => {
		if (data.indexOf('-1') === 0) {
			// If we need to authorize with FFZ, gets the auth code and does that.
			// Original command will still be executed once authed, so no need for any other checking.
			if (data.indexOf('-1 do_authorize') === 0) {
				var authCode = JSON.parse(data.substr(16));
				sendAuthThroughTwitchChat(authCode);
			}

			// This is returned when the follower buttons are updated (including through this script).
			else if (data.indexOf('-1 follow_buttons') === 0) {
				console.log(data);
				console.log('Got follow_buttons from FrankerFaceZ connection.');
			}
		}
	});
}

// Used to update the following buttons/emoticons on Twitch.
// usernames is an array of Twitch usernames; if blank it will remove any channels already there.
function setFFZFollowing(usernames) {
	console.log('Attempting to set FrankerFaceZ Twitch names.');
	// Checks to make sure we are connected and can do this.
	if (ffzWSConnected) {
		console.log('Sent FrankerFaceZ Twitch names.');
		sendMessage('update_follow_buttons ' + JSON.stringify([twitchTokens.name,usernames]), message => {
			var updatedClients = JSON.parse(message.substr(3))['updated_clients'];
			console.log('FrankerFaceZ buttons have been updated for ' + updatedClients + ' viewers.');
		});
	}
}

// Used to send a message over the WebSocket; calls back the message when it gets the "ok" message back.
function sendMessage(message, callback) {
	ffzWS.send(`${ffzWSMessageNumber} ${message}`);
	var thisMessageNumber = ffzWSMessageNumber; ffzWSMessageNumber++;

	var messageEvent; ffzWS.on('message', messageEvent = function(data) {
		if (data.indexOf(thisMessageNumber + ' ok') === 0) {
			ffzWS.removeListener('message', messageEvent);
			if (callback) {callback(data.substr(data.indexOf(' ')+1));}
		}
	});
}

function ping() {
	var pongWaitTimeout;
	ffzWS.ping();

	var listenerFunc = function(data) {
		clearTimeout(pongWaitTimeout);
		ffzWSPingTimeout = setTimeout(ping, 60000); // PING every minute
		ffzWS.removeListener('pong', listenerFunc);
	}
	ffzWS.on('pong', listenerFunc);
	
	// Disconnect if a PONG was not received within 10 seconds.
	pongWaitTimeout = setTimeout(() => {
		console.log('FrankerFaceZ PING/PONG failed, terminating connection.');
		ffzWS.removeListener('pong', listenerFunc);
		ffzWS.terminate();
	}, 10000);
}

// Used to send the auth code for updating the following buttons/emotes when needed.
function sendAuthThroughTwitchChat(auth) {
	console.log('Attempting to authenticate with FrankerFaceZ.');
	
	checkTwitchTokenValidity(() => {
		// Settings for the temporary Twitch chat connection.
		var options = {
			options: {
				//debug: true  // might want to turn off when in production
			},
			connection: {
				secure: true
			},
			identity: {
				username: twitchTokens.name,
				password: twitchTokens.access
			}
		};

		var client = new TwitchJS.client(options);
		client.connect();

		client.once('connected', (address, port) => {
			console.log('Connected to Twitch chat to authenticate with FrankerFaceZ.');
			// Send the auth code to the specific Twitch channel.
			client.say('frankerfacezauthorizer', 'AUTH ' + auth);

			// Giving it 5 seconds until we disconnect just to make sure the message was sent.
			setTimeout(() => {client.disconnect();}, 5000);
		});
	});
}

// Picks a server randomly, 1-2-2-2 split in which it picks.
function pickServer() {
	switch(randomInt(0, 7)) {
		case 0:
			return 'wss://catbag.frankerfacez.com/';
		case 1:
		case 2:
			return 'wss://andknuckles.frankerfacez.com/';
		case 3:
		case 4:
			return 'wss://tuturu.frankerfacez.com/';
		case 5:
		case 6:
			return 'wss://lilz.frankerfacez.com/';
	}
}

// Function to return a random integer.
function randomInt(low, high) {
	return Math.floor(Math.random() * (high - low) + low);
}

function setFeaturedChannelsExt(usernames) {
	var usernamesString = usernames.join(',');
	if (!usernames.length) usernamesString = '';
	console.log('Attempting to update Twitch extension "Featured Channels" information.');
	needle.get(`https://api.furious.pro/featuredchannels/bot/${config.twitchExtToken}/${usernamesString}`, (err, resp) => {
		if (!err && resp.statusCode === 200)
			console.log('Successfully updated Twitch extension "Featured Channels" information.');
		else
			console.log('Error updating Twitch extension "Featured Channels" information.');
	});
}