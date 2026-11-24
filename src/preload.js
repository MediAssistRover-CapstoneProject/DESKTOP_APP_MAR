'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const calls = ['settings', 'saveSettings', 'discover', 'wifiStatus', 'wifiNetworks', 'connectLaptopWifi',
  'connectRobot', 'disconnectRobot', 'robotStatus', 'robotWifiScan', 'configureRobotWifi',
  'login', 'logout', 'cloudCatalog', 'cloudStatus', 'startMapping', 'startNavigation', 'stopRobot',
  'robotLogs', 'openPage', 'pickKey'];
const api = Object.fromEntries(calls.map(name => [name, input => ipcRenderer.invoke('mar:' + name, input)]));
api.onProgress = callback => {
  const listener = (_event, message) => callback(message);
  ipcRenderer.on('mar:progress', listener);
  return () => ipcRenderer.removeListener('mar:progress', listener);
};
contextBridge.exposeInMainWorld('mar', Object.freeze(api));
