const {
	app,
	BaseWindow,
	WebContentsView,
	ipcMain,
	shell,
	globalShortcut
} = require('electron');
const path = require('path');
const fs = require('fs');
const services = require('./services');
const { createTray, updateTrayMenu, destroyTray } = require('./tray');

let mainWindow;
let mainView;
let tabs = new Map();
let activeTabId = null;
let statusInterval = null;

const TAB_BAR_HEIGHT = 42;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Funções de configuração
function loadConfig() {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
		}
	} catch (error) {
		console.error('Error loading config:', error);
	}
	return null;
}

function saveConfig(config) {
	try {
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
		return true;
	} catch (error) {
		console.error('Error saving config:', error);
		return false;
	}
}

function createWindow() {
	mainWindow = new BaseWindow({
		autoHideMenuBar: true,
		width: 1400,
		height: 900,
		minWidth: 1024,
		minHeight: 600,
		show: false
	});

	mainView = new WebContentsView({
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false
		}
	});

	mainWindow.contentView.addChildView(mainView);
	
	updateViewBounds();
	
	mainView.webContents.loadFile('index.html');
	
	mainView.webContents.on('did-finish-load', () => {
		updateViewBounds();
		mainWindow.show();
		startStatusPolling();
	});

	mainWindow.on('resize', updateViewBounds);
	
	mainWindow.on('close', (event) => {
		if (!app.isQuitting) {
			event.preventDefault();
			mainWindow.hide();
		}
	});
	
	mainWindow.on('closed', () => {
		mainWindow = null;
		tabs.clear();
		stopStatusPolling();
	});

	createTray(mainWindow);
}

function startStatusPolling() {
	sendServicesStatus();
	statusInterval = setInterval(sendServicesStatus, 5000);
}

function stopStatusPolling() {
	if (statusInterval) {
		clearInterval(statusInterval);
		statusInterval = null;
	}
}

async function sendServicesStatus() {
	if (!mainView) return;
	const status = await services.getAllServicesStatus();
	mainView.webContents.send('services-status', status);
	updateTrayMenu();
}

const STATUS_BAR_HEIGHT = 40;

function updateViewBounds() {
	if (!mainWindow) return;
	const bounds = mainWindow.getContentBounds();
	const hasActiveTabs = tabs.size > 0;
	
	// mainView sempre com altura completa
	mainView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });

	// Tabs ficam entre a barra de abas e o status bar, POR CIMA da mainView
	tabs.forEach((tab) => {
		if (tab.view) {
			tab.view.setBounds({
				x: 0,
				y: TAB_BAR_HEIGHT,
				width: bounds.width,
				height: bounds.height - TAB_BAR_HEIGHT - STATUS_BAR_HEIGHT
			});
		}
	});
}

function createTab(tabId, url, title) {
	if (tabs.has(tabId)) {
		activateTab(tabId);
		return;
	}

	// Garantir que a aba Home existe primeiro
	ensureHomeTab();

	const tabView = new WebContentsView({
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false
		}
	});

	// Adicionar tab depois da mainView para ficar por cima
	mainWindow.contentView.addChildView(tabView);
	tabView.webContents.loadURL(url);
	tabView.setVisible(true);

	tabs.set(tabId, {
		id: tabId,
		url: url,
		title: title,
		view: tabView,
		isHome: false
	});

	activateTab(tabId);
	updateViewBounds();
	notifyTabsUpdate();
}

function activateTab(tabId) {
	tabs.forEach((tab, id) => {
		if (tab.view) {
			tab.view.setVisible(id === tabId);
		}
	});
	activeTabId = tabId;
	
	// Notificar frontend se está mostrando Home (para mostrar/esconder cards)
	const isHomeActive = tabId === HOME_TAB_ID;
	mainView.webContents.send('home-visibility', isHomeActive);
	
	notifyTabsUpdate();
}

function closeTab(tabId) {
	const tab = tabs.get(tabId);
	if (!tab) return;
	
	// Não permitir fechar a aba Home
	if (tab.isHome) return;

	mainWindow.contentView.removeChildView(tab.view);
	tab.view.webContents.close();
	tabs.delete(tabId);

	// Se só sobrou a Home, remover a Home também (voltar ao estado normal)
	if (tabs.size === 1 && tabs.has(HOME_TAB_ID)) {
		tabs.delete(HOME_TAB_ID);
		activeTabId = null;
		mainView.webContents.send('home-visibility', true);
	} else if (activeTabId === tabId) {
		// Ativar a primeira aba que não seja a que foi fechada
		for (const [id] of tabs) {
			if (id !== tabId) {
				activateTab(id);
				break;
			}
		}
	}

	updateViewBounds();
	notifyTabsUpdate();
}

function notifyTabsUpdate() {
	if (!mainView) return;
	const tabsList = Array.from(tabs.values()).map(t => ({
		id: t.id,
		title: t.title,
		url: t.url,
		active: t.id === activeTabId,
		closeable: !t.isHome
	}));
	mainView.webContents.send('tabs-updated', tabsList);
}

const HOME_TAB_ID = 'home';

function ensureHomeTab() {
	// Se não há abas, criar a aba Home primeiro
	if (tabs.size === 0) {
		tabs.set(HOME_TAB_ID, {
			id: HOME_TAB_ID,
			url: 'home',
			title: 'Home',
			view: null,  // Home usa a mainView
			isHome: true
		});
	}
}

ipcMain.on('open-service', (event, { url, openType, serviceName }) => {
	const title = serviceName || getServiceNameFromUrl(url);
	
	if (openType === 'window') {
		const serviceWindow = new BaseWindow({
			width: 1920,
			height: 1080,
			minWidth: 1024,
			minHeight: 768,
			title: `HeroDev - ${title}`
		});
		const serviceView = new WebContentsView();
		serviceWindow.contentView.addChildView(serviceView);
		serviceView.webContents.loadURL(url);
		
		// Atualizar título quando a página carregar
		serviceView.webContents.on('page-title-updated', (e, pageTitle) => {
			serviceWindow.setTitle(`HeroDev - ${title}`);
		});
		
		serviceWindow.on('resize', () => {
			const bounds = serviceWindow.getContentBounds();
			serviceView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
		});
		const bounds = serviceWindow.getContentBounds();
		serviceView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
	} else if (openType === 'tab') {
		const tabId = `tab-${Date.now()}`;
		createTab(tabId, url, title);
	} else if (openType === 'browser') {
		shell.openExternal(url);
	}
});

// Helper para obter nome do serviço baseado na URL
function getServiceNameFromUrl(url) {
	try {
		const urlObj = new URL(url);
		const port = urlObj.port;
		const portToName = {
			'8080': urlObj.pathname.includes('phpmyadmin') ? 'phpMyAdmin' : 'localhost',
			'12777': 'VSCode',
			'8081': 'Arquivos',
			'8082': 'Mongo UI',
			'8083': 'NGINX',
			'9090': 'Prometheus',
			'3000': 'Grafana'
		};
		return portToName[port] || urlObj.hostname;
	} catch {
		return url;
	}
}

ipcMain.on('tab-activate', (event, tabId) => {
	activateTab(tabId);
});

ipcMain.on('tab-close', (event, tabId) => {
	closeTab(tabId);
});

ipcMain.on('tab-close-all', () => {
	// Fechar todas as abas exceto a Home
	const tabIds = Array.from(tabs.keys());
	tabIds.forEach(id => {
		if (id !== HOME_TAB_ID) {
			closeTab(id);
		}
	});
	// Se só sobrou a Home, remover ela também
	if (tabs.size === 1 && tabs.has(HOME_TAB_ID)) {
		tabs.delete(HOME_TAB_ID);
		activeTabId = null;
		mainView.webContents.send('home-visibility', true);
		notifyTabsUpdate();
	}
});

ipcMain.on('open-external', (event, url) => {
	shell.openExternal(url);
});

ipcMain.handle('service-action', async (event, { service, action }) => {
	try {
		switch (action) {
			case 'start':
				await services.startService(service);
				break;
			case 'stop':
				await services.stopService(service);
				break;
			case 'restart':
				await services.restartService(service);
				break;
		}
		await sendServicesStatus();
		return { success: true };
	} catch (error) {
		return { success: false, error: error.message };
	}
});

ipcMain.handle('container-action', async (event, action) => {
	try {
		switch (action) {
			case 'start':
				await services.startContainer();
				break;
			case 'stop':
				await services.stopContainer();
				break;
			case 'restart':
				await services.restartContainer();
				break;
		}
		await sendServicesStatus();
		return { success: true };
	} catch (error) {
		return { success: false, error: error.message };
	}
});

ipcMain.handle('get-services-status', async () => {
	return services.getAllServicesStatus();
});

ipcMain.handle('get-service-logs', async (event, { service, lines }) => {
	return services.getServiceLogs(service, lines);
});

ipcMain.handle('get-container-info', async () => {
	return services.getContainerInfo();
});

// Config handlers
ipcMain.handle('get-config', async () => {
	return loadConfig();
});

ipcMain.handle('save-config', async (event, config) => {
	return saveConfig(config);
});

// DevTools toggle
ipcMain.on('toggle-devtools', (event) => {
	if (mainView && mainView.webContents) {
		mainView.webContents.toggleDevTools();
	}
});

app.whenReady().then(() => {
	createWindow();
	
	// Registrar atalho global para DevTools (Ctrl+Shift+I)
	globalShortcut.register('CommandOrControl+Shift+I', () => {
		if (mainView && mainView.webContents) {
			mainView.webContents.toggleDevTools();
		}
	});
});

app.on('will-quit', () => {
	// Desregistrar todos os atalhos
	globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
	app.isQuitting = true;
	destroyTray();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', () => {
	if (!mainWindow) {
		createWindow();
	} else {
		mainWindow.show();
	}
});
