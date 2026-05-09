@echo off
chcp 65001
echo ==============================================
echo  仅使用项目内置 Node.js，无系统污染
echo  Node 路径：%cd%\node\node-v24.15.0-win-x64
echo ==============================================

:: 临时设置环境变量（仅当前窗口生效，关闭即消失）
set "NODE_PATH=%cd%\node\node-v24.15.0-win-x64"
set "PATH=%NODE_PATH%;%cd%\.local\npm;%PATH%"
set "NPM_CONFIG_USERCONFIG=%cd%\.npmrc"
set "YARN_CONFIG_USERCONFIG=%cd%\.yarnrc"

:: 验证版本（确认用的是项目内的，不是系统的）
echo 正在使用的 Node 版本：
node -v
echo 正在使用的 npm 版本：
npm -v
echo 正在使用的 yarn 版本：
yarn -v

echo.
echo 开始安装项目依赖...
yarn install

echo.
echo 启动开发服务器...
yarn dev

pause