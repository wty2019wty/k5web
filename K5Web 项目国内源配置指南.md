# K5Web 项目国内源配置指南

我给你做**纯项目内、零系统污染**的国内源配置，直接修改你项目根目录已有的 `\.npmrc` 和 `\.yarnrc` 文件，**仅对当前 k5web 项目生效**，使用国内最稳定的 **npmmirror 镜像源**（原淘宝源），下载速度提升 10 倍以上。

---

# 一、配置 npm 国内源

打开项目根目录的 `\.npmrc` 文件，**直接替换为以下内容**（包含隔离路径 \+ 国内源）：

```ini
# 项目内隔离路径（保留之前的配置）
prefix=./.local/npm
cache=./.local/npm/cache
userconfig=./.local/npm/.npmrc

# ==================== 国内源配置 ====================
# npm 官方镜像（国内最快）
registry=https://registry.npmmirror.com
# 可选：node-sass 镜像（前端项目常用）
sass_binary_site=https://npmmirror.com/mirrors/node-sass
# 可选：Electron 镜像（适配项目依赖）
electron_mirror=https://npmmirror.com/mirrors/electron/
```

---

# 二、配置 yarn 国内源

打开项目根目录的 `\.yarnrc` 文件，**直接替换为以下内容**：

```yaml
# 项目内隔离路径（保留之前的配置）
global-folder "./.local/yarn/global"
cache-folder "./.local/yarn/cache"
yarn-offline-cache "./.local/yarn/offline-cache"

# ==================== 国内源配置 ====================
# yarn 国内镜像源
registry "https://registry.npmmirror.com"
```

---

# 三、一键验证源是否生效（项目根目录执行）

## 验证 npm 源

```cmd
node\node-v24.15.0-win-x64\npm.cmd config get registry
```

✅ 正确结果：`https://registry\.npmmirror\.com`

## 验证 yarn 源

```cmd
node\node-v24.15.0-win-x64\npx.cmd yarn config get registry
```

✅ 正确结果：`https://registry\.npmmirror\.com`

---

# 四、直接使用（无需额外操作）

1. 双击你之前创建的 `start\-dev\.bat`

2. 自动使用**项目内 Node \+ 国内源**安装依赖、启动项目

3. 全程无系统修改、无残留

---

# 五、补充：临时切换源（命令行，仅当前窗口生效）

如果不想改文件，临时用命令切换（不推荐，优先文件配置）：

```cmd
# npm 临时换国内源
node\node-v24.15.0-win-x64\npm.cmd config set registry https://registry.npmmirror.com

# yarn 临时换国内源
node\node-v24.15.0-win-x64\npx.cmd yarn config set registry https://registry.npmmirror.com
```

---

### 总结

1. **纯项目内配置**：不修改系统、不影响其他项目

2. **国内最快镜像**：npmmirror 永久可用，告别下载失败 / 慢

3. **一键生效**：改完配置文件，直接运行项目即可

4. **完全适配**：兼容你项目内置的 Node\.js 路径






















我直接按照你**项目内置 Node.js 路径**（`项目根目录\node\node-v24.15.0-win-x64\node.exe`）做**Windows 专属、零系统污染、纯项目内运行**的完整配置，全程不修改系统环境变量、不写入系统文件，所有依赖/缓存/配置都锁在项目里。

---

# 一、先确认你的目录结构（必须一致）
假设你的 `k5web` 项目根目录是：
`D:\projects\k5web\`（你自己的项目路径）

你的 Node 存放路径（你提供的）：
```
k5web项目根目录
└── node/
    └── node-v24.15.0-win-x64/
        ├── node.exe       ✅ 核心文件
        ├── npm.cmd        ✅ 自带的 npm
        └── 其他文件
```

---

# 二、一键配置（3 分钟完成，纯项目内）
全程在 **项目根目录** 操作，只改项目内文件！

## 1. 创建项目内缓存文件夹（存放 npm/yarn）
在项目根目录，新建文件夹结构：
```
项目根目录
├── .local/
│   ├── npm/      # npm 缓存+全局包
│   └── yarn/     # yarn 缓存+全局包
```
Windows 快速创建命令（PowerShell/CMD 项目根目录执行）：
```powershell
mkdir .local\npm
mkdir .local\yarn
```

## 2. 创建项目内 `.npmrc`（强制 npm 只使用项目路径）
在**项目根目录**新建文件 `.npmrc`，写入：
```ini
# 全部指向项目内，绝不读取系统
prefix=./.local/npm
cache=./.local/npm/cache
registry=https://registry.npmmirror.com
```

## 3. 创建项目内 `.yarnrc`（强制 yarn 只使用项目路径）
在**项目根目录**新建文件 `.yarnrc`，写入：
```yaml
global-folder "./.local/yarn/global"
cache-folder "./.local/yarn/cache"
```

---

# 三、核心：用「项目内的 Node」安装 yarn（不装系统）
你不能用系统的 npm，必须**调用项目里的 npm.cmd**：

打开 **CMD / PowerShell**，**cd 到项目根目录**，执行：
```powershell
# 调用项目内置 npm，把 yarn 安装到 项目内的 .local/npm
node\node-v24.15.0-win-x64\npm.cmd install -g yarn
```

✅ 安装完成后：
`yarn` 会被安装在 `项目\.local\npm\` 里，**完全不碰系统**。

---

# 四、终极方案：Windows 批处理脚本（双击即用）
这是最省心的方式，**双击就自动用项目内的 Node / npm / yarn**，不用每次输路径，也不污染系统。

在**项目根目录**新建文件：
`start-dev.bat`

复制以下代码（直接用，适配你的 Node 路径）：
```batch
@echo off
chcp 65001
echo ==============================================
echo  仅使用项目内置 Node.js，无系统污染
echo  Node 路径：%cd%\node\node-v24.15.0-win-x64
echo ==============================================

:: 【核心】临时设置环境变量（仅当前窗口生效，关闭即消失）
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
```

---

# 五、使用方法（超级简单）
1. **双击项目根目录的 `start-dev.bat`**
2. 脚本会自动：
   - 调用**项目内的 node.exe**
   - 用**项目内的 yarn** 安装依赖
   - 启动 `yarn dev` 运行 k5web
3. **全程不修改系统、不生成系统文件**

---

# 六、验证是否完全隔离（检查这 3 个路径）
在脚本打开的终端里执行：
```powershell
# 查看 npm 全局路径 → 必须是 项目\.local\npm
npm config get prefix

# 查看 npm 缓存 → 必须是 项目\.local\npm\cache
npm config get cache

# 查看 yarn 缓存 → 必须是 项目\.local\yarn\cache
yarn config get cache-folder
```

✅ **正确结果**：所有路径都在你的 `k5web` 项目内，**没有出现 C:\Users\用户名** 等系统目录。

---

# 七、完全干净卸载
不需要这个项目时：
**直接删除整个 k5web 文件夹**
→ Node、npm、yarn、所有缓存、所有依赖、所有配置 **全部删除**，系统无任何残留。

---

### 总结
1. **严格使用你指定的 Node 路径**：`项目\node\node-v24.15.0-win-x64\node.exe`
2. **零系统修改**：不碰环境变量、不写系统配置、不生成系统缓存
3. **一键运行**：双击 `start-dev.bat` 即可开发 k5web
4. **删项目即清空**：100% 干净隔离