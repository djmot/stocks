var express = require('express');
var app = express();
var server = require('http').createServer(app);
var WebSocketServer = require('ws').Server;
var wsServer = new WebSocketServer({ server: server });
var request = require('request');

app.use('/public', express.static(process.cwd() + '/public'));

app.route('/') 
    .get(function (req, res) {
        res.sendFile(process.cwd() + '/public/index.html');
    });
    
    
function onSendError(error) {
    if (error) {
        console.log('Error sending message from server: ' + error);
    }
}

// Entry format: 
// {
//  name: <stock symbol>,
//  company: <company name>
// 	data: <array of chart data>,
//	tooltip: { valueDecimals: 2 } 
//  color: <a color string from colorList>
// }
var seriesList = [];
var colorList = ['#4292f4', '#f788ee', '#5bffad', '#ff4444', '#ffaf26', '#1f1533'];
var colorCounter = -1;
function getColor () {
    colorCounter++;
    if (colorCounter >= colorList.length) {
        colorCounter = 0;
    }
    return colorList[colorCounter];
}

function removeSeries (company) {
	var ind = -1;
	for (var i = 0; i < seriesList.length; i++) {
		if (seriesList[i].company === company) {
			ind = i;
			break;
		}
	}
	if (ind < 0) { return false; }
	seriesList.splice(ind, 1);
	return true;
}

    
wsServer.on('connection', function connection (ws) {
    // Client expects stringified object 
    // { type: <see validTypes>, 
    //   message: <content> }
    var validTypes = ['error', 'message', 'lookup', 'add', 'remove', 'load'];
    function sendError (msg) {
        ws.send(JSON.stringify({
            type: 'error',
            message: msg
        }), onSendError);
    }
    function sendGood (msg, type) {
        if (validTypes.indexOf(type) < 0) {
            console.log('Bad type passed to sendGood: ' + type);
            return;
        }
        ws.send(JSON.stringify({
            type: type,
            message: msg
        }), onSendError);
    }
    function broadcast (msg, type) {
        if (validTypes.indexOf(type) < 0) {
            console.log('Bad type passed to broadcast: ' + type);
            return;
        }
        wsServer.clients.forEach(function (client) {
           client.send(JSON.stringify({
               type: type,
               message: msg
           }), onSendError); 
        });
    }
    
    function markitLookup (input) {
        // Look up list of stocks.
        var url = 'http://dev.markitondemand.com/Api/v2/Lookup/json?input=' + input;
        request({ method: 'GET', url: url }, function (error, response, body) {
            if (error) {
                sendError('Lookup data not received');
                return;
            }
            if (body[0] !== '[')  {
                sendError('Markit API lookup error');
                return;
            }
            
            // Return list to client.
            sendGood(body, 'lookup');
        });
    }
    function markitChart (clientInput) {
        // clientInput format: 
        // { symbol: <stock symbol>, name: <company name> }
        
        // Make sure this stock isn't already in seriesList.
        for (var i = 0; i < seriesList.length; i++) {
    		if (seriesList[i].company === clientInput.name) {
    		    sendError('Stock is already in seriesList');
    			return;
    		}
        }
        
        // Compose API input.
        var chartDataInput = {
			Normalized: false,
			NumberOfDays: 365*3,
			DataPeriod: 'Day',
			Elements: [
				{ 
					Symbol: clientInput.symbol,
					Type: 'price',
					Params: ['c']
				}
			]
		};
		
        // Get chart data from API.
        var url = 'http://dev.markitondemand.com/Api/v2/InteractiveChart/json?parameters=' + JSON.stringify(chartDataInput); 
        request({ method: 'GET', url: url }, function (error, response, body) {
            if (error) {
                sendError('Chart data not received');
                return;
            }
            try {
                var data = JSON.parse(body);
                var element = data.Elements[0];
            } catch (e) {
                sendError('Unexpected body in Markit chart data call');
                return;
            }
            if (!element) {
                sendError('No data for that name');
                return;
            }
            // Process data.
            var dates = data.Dates;
        	var values = element.DataSeries.close.values;
        	var chartData = [];
        	for (var i = 0; i < dates.length; i++) {
        		var date = new Date(dates[i]);
        		chartData.push([date.getTime(), values[i]]);
        	}
        	var newSeries = {
        		name: element.Symbol,
        		company: clientInput.name,
        		data: chartData,
        		tooltip: { valueDecimals: 2 },
        		color: getColor()
        	};
        	// Add data to seriesList and return to ALL clients
        	seriesList.push(newSeries);
        	broadcast(JSON.stringify(newSeries), 'add');
        });
    }
    
    // Client sends stringified object 
    // { operation: <valid operation>, data: <query parameter> }
    ws.on('message', function incoming (msg) {
        try {
            var msgParsed = JSON.parse(msg);
        } catch (e) {
            sendError('Could not parse JSON');
            return;
        }
        switch (msgParsed.operation) {
            case 'lookup': 
                markitLookup(msgParsed.data);
                break;
            case 'add':
                markitChart(msgParsed.data);
                break;
            case 'remove':
                if (removeSeries(msgParsed.data)) {
                    sendGood('Series removed', 'message');
                    broadcast(msgParsed.data, 'remove');
                } else {
                    sendError('Series to remove was not found');
                }
                break;
            default:
                sendError('Invalid operation: ' + msgParsed.operation);
                break;
        }
    });
    
    // On connection, send stringified seriesList for client to load.
    sendGood(JSON.stringify(seriesList), 'load');
});

server.listen(process.env.PORT, process.env.IP, function () {
    console.log('Node listening on port: ' + process.env.PORT);
});