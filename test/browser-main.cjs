// Tiny Electron "browser" for testing the web app: opens URL in a window with its own profile.
const { app, BrowserWindow } = require("electron");
if (process.env.UD) app.setPath("userData", process.env.UD);
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: Number(process.env.W || 390), height: Number(process.env.H || 844), show: true });
  if (process.env.UA) w.webContents.setUserAgent(process.env.UA);
  w.loadURL(process.env.URL);
});
