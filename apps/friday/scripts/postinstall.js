const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

try {
    // run electron-builder install-app-deps
    console.log('Running electron-builder install-app-deps...');
    execSync('electron-builder install-app-deps', { stdio: 'inherit' });
    console.log('electron-builder install-app-deps completed.');

    // find electron install.js
    const pnpmDir = path.join(__dirname, '../../../node_modules/.pnpm');

    if (!fs.existsSync(pnpmDir)) {
        console.log('pnpm directory not found, skipping electron install.');
        process.exit(0);
    }

    const dirs = fs.readdirSync(pnpmDir);
    const electronDirs = dirs.filter(dir => dir.startsWith('electron@'));

    if (electronDirs.length === 0) {
        console.log('No electron directory found in .pnpm, skipping electron install.');
        process.exit(0);
    }

    // use the first version
    const electronDir = electronDirs[0];
    const electronInstallPath = path.join(pnpmDir, electronDir, 'node_modules/electron/install.js');

    if (fs.existsSync(electronInstallPath)) {
        console.log(`Running electron install from: ${electronInstallPath}`);
        execSync(`node "${electronInstallPath}"`, { stdio: 'inherit' });
        console.log('Electron install completed.');
    } else {
        console.log(`Electron install.js not found at: ${electronInstallPath}`);
    }
} catch (error) {
    console.error('Error during postinstall:', error.message);
    process.exit(1);
}
