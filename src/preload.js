'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const calls = ['settings', 'saveSettings', 'changeServer', 'discover', 'wifiStatus', 'wifiNetworks', 'connectLaptopWifi',
  'connectRobot', 'disconnectRobot', 'robotStatus', 'robotWifiScan', 'configureRobotWifi',
  'login', 'logout', 'cloudCatalog', 'cloudStatus', 'startMapping', 'startNavigation', 'stopRobot',
  'robotLogs', 'openPage', 'pickKey'];
const api = Object.fromEntries(calls.map(name => [name, input => ipcRenderer.invoke('mar:' + name, input)]));
function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
api.onProgress = callback => subscribe('mar:progress', callback);
api.onAuthChanged = callback => subscribe('mar:authChanged', callback);
contextBridge.exposeInMainWorld('mar', Object.freeze(api));
