const fs = require('fs');
const path = require('path');

const src = "C:\\Users\\mail2\\.gemini\\antigravity-ide\\brain\\0cbd2971-7381-41bc-bf59-99c7ca7060ae\\yentick_icon_1780035544804.png";
const destDir = "c:\\Users\\mail2\\Develop\\YenTick\\assets";
const dest = path.join(destDir, "icon-128.png");

try {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    console.log("Created directory:", destDir);
  }
  fs.copyFileSync(src, dest);
  console.log("Successfully copied icon to:", dest);
} catch (err) {
  console.error("Error copying file:", err);
  process.exit(1);
}
