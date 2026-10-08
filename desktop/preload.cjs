const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('compute', {
  invoke: async (action, data) => {
    const reply = await ipcRenderer.invoke('compute', action, data);
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  }
});
