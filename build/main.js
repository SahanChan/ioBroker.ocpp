"use strict";
/*
 * Created with @iobroker/create-adapter v2.0.1
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const states_1 = require("./lib/states");
const ocpp_eliftech_1 = require("ocpp-eliftech");
class Ocpp extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'ocpp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', Ocpp.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        // subscribe own states
        this.subscribeStates('*');
        this.clientTimeouts = {};
        this.knownClients = [];
        this.client = {
            info: {
                connectors: []
            }
        };
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.log.info('Starting OCPP Server');
        const server = new ocpp_eliftech_1.CentralSystem();
        const port = await this.getPortAsync(this.config.port);
        server.listen(port);
        this.log.info(`Server listening on port ${port}`);
        server.onRequest = async (client, command) => {
            const connection = client.connection;
            // we received a new command, first check if the client is known to us
            if (this.knownClients.indexOf(connection.url) === -1) {
                this.log.info(`New device connected: "${connection.url}"`);
                // not known yet
                this.knownClients.push(connection.url);
                // on connection, ensure objects for this device are existing
                await this.createDeviceObjects(connection.url);
                // device is now connected
                await this.setDeviceOnline(connection.url);
            }
            switch (true) {
                case (command instanceof ocpp_eliftech_1.OCPPCommands.BootNotification):
                    this.log.info(`Received boot notification from "${connection.url}"`);
                    this.client.info = {
                        connectors: [],
                        ...command
                    };
                    // device booted, extend native to object
                    await this.extendObjectAsync(connection.url, {
                        native: command
                    });
                    // we give 90 seconds to send next heartbeat
                    if (this.clientTimeouts[connection.url]) {
                        clearTimeout(this.clientTimeouts[connection.url]);
                    }
                    this.clientTimeouts[connection.url] = setTimeout(() => this.timedOut(connection.url), 90000);
                    // we are requesting heartbeat every 60 seconds
                    return {
                        status: 'Accepted',
                        currentTime: new Date().toISOString(),
                        interval: 60
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.Authorize):
                    this.log.info(`Received Authorization Request from "${connection.url}"`);
                    return {
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case command instanceof ocpp_eliftech_1.OCPPCommands.StartTransaction:
                    this.log.info(`Received Start transaction from "${connection.url}"`);
                    return {
                        transactionId: 1,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.StopTransaction):
                    this.log.info(`Received stop transaction from "${connection.url}"`);
                    return {
                        transactionId: 1,
                        idTagInfo: {
                            status: 'Accepted'
                        }
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.Heartbeat):
                    this.log.info(`Received heartbeat from "${connection.url}"`);
                    // we give 90 seconds to send next heartbeat
                    if (this.clientTimeouts[connection.url]) {
                        clearTimeout(this.clientTimeouts[connection.url]);
                    }
                    this.clientTimeouts[connection.url] = setTimeout(() => this.timedOut(connection.url), 90000);
                    return {
                        currentTime: new Date().toISOString()
                    };
                case (command instanceof ocpp_eliftech_1.OCPPCommands.StatusNotification):
                    this.log.info(`Received Status Notification from "${connection.url}": ${command.status}`);
                    // {"connectorId":1,"errorCode":"NoError","info":"","status":"Preparing","timestamp":"2021-10-27T15:30:09Z","vendorId":"","vendorErrorCode":""}
                    await this.setStateChangedAsync(`${connection.url}.connectorId`, command.connectorId, true);
                    // set status state
                    await this.setStateAsync(`${connection.url}.status`, command.status, true);
                    const connectorIndex = this.client.info.connectors.findIndex(item => command.connectorId === item.connectorId);
                    if (connectorIndex === -1) {
                        this.client.info.connectors.push({
                            ...command
                        });
                    }
                    else {
                        this.client.info.connectors[connectorIndex] = {
                            ...command
                        };
                    }
                    return {};
                default:
                    this.log.warn(`Command not implemented from "${connection.url}": ${JSON.stringify(command)}`);
            }
        };
    }
    /**
     * Is called if client timed out, sets connection to offline
     * @param device name of the wallbox device
     */
    async timedOut(device) {
        this.log.warn(`Client "${device}" timed out`);
        const idx = this.knownClients.indexOf(device);
        if (idx !== -1) {
            // client is in list, but now no longer active
            this.knownClients.splice(idx, 1);
        }
        await this.setStateAsync(`${device}.connected`, false, true);
        const connState = await this.getStateAsync('info.connection');
        if (typeof (connState === null || connState === void 0 ? void 0 : connState.val) === 'string') {
            // get devices and convert them to an array
            const devices = connState.val.split(',');
            const idx = devices.indexOf(device);
            if (idx !== -1) {
                // device is in list, so remove it and set updated state
                devices.splice(idx, 1);
                await this.setStateAsync('info.connection', devices.join(','), true);
            }
        }
    }
    /**
     * Sets the corresponding online states
     * @param device name of the wallbox device
     */
    async setDeviceOnline(device) {
        await this.setStateAsync(`${device}.connected`, true, true);
        const connState = await this.getStateAsync('info.connection');
        if (typeof (connState === null || connState === void 0 ? void 0 : connState.val) === 'string') {
            const devices = connState.val.split(',');
            if (devices.indexOf(device) === -1) {
                // device not yet in array
                devices.push(device);
                await this.setStateAsync('info.connection', devices.join(','), true);
            }
        }
        else {
            // just set device
            await this.setStateAsync('info.connection', device, true);
        }
    }
    /**
     * Creates the corresponding state objects for a device
     * @param device name of the wallbox device
     */
    async createDeviceObjects(device) {
        await this.extendObjectAsync(device, {
            type: 'device',
            common: {
                name: device
            },
            native: {}
        }, { preserve: { common: ['name'] } });
        for (const obj of states_1.stateObjects) {
            const id = obj._id;
            obj._id = `${device}.${obj._id}`;
            await this.extendObjectAsync(obj._id, obj, { preserve: { common: ['name'] } });
            obj._id = id;
        }
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    async onUnload(callback) {
        try {
            // clear all timeouts
            for (const [device, timeout] of Object.entries(this.clientTimeouts)) {
                await this.setStateAsync(`${device}.connected`, false, true);
                clearTimeout(timeout);
            }
            await this.setStateAsync('info.connection', '', true);
            callback();
        }
        catch (_a) {
            callback();
        }
    }
    /**
     * Is called if a subscribed state changes
     */
    static onStateChange(id, state) {
        if (!state || state.ack) {
            // if state deleted or already acknowledged
            return;
        }
        // handle state change
        const idArr = id.split('.');
        if (idArr[3] === 'enabled') {
            // enable/disable charger
        }
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new Ocpp(options);
}
else {
    // otherwise start the instance directly
    (() => new Ocpp())();
}
//# sourceMappingURL=main.js.map