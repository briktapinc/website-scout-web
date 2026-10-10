'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The ONLY surface exposed to the renderer (context isolation on).
// All data access goes through window.api.invoke(channel, ...args).
contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => {
    if (typeof channel !== 'string') {
      return Promise.reject(new Error('INVALID_CHANNEL'));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
});
