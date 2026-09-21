# File Manager Server

[WIP] A lightweight, self-hosted file manager with **zero external dependencies**. Clone it, run it with Node.js, and you have a browser file explorer for uploading and downloading files on that machine — no npm install, no FTP, no SSH.

https://github.com/user-attachments/assets/813328ac-4639-4804-a269-c67a0fa2bea6

## Features

- **Built-in file explorer** — browse directories, grid or list view
- **Upload to any directory** with chunked transfers, so large files survive a flaky connection
- **Real-time progress** — speed, estimated time remaining, and a cancel button
- **Download one file, or several as a ZIP**
- **File type icons** so you can see what's what at a glance
- **Zero dependencies** — just Node.js and `server.js`

## How to run it

```bash
git clone https://github.com/p32929/node_file_manager_server.git
cd node_file_manager_server
node server.js
```

Then open `http://<server-ip>:3999` in a browser and start browsing.

Press `Ctrl+C` in the terminal to stop it.

## When to use it

- You need a fast file transfer without setting up FTP or SSH
- You want a temporary transfer tool between two machines
- You want full control over exactly where files land

## When NOT to use it

- **If security matters** — there is **no authentication** by default. Anyone who can reach the port can read and write files.
- For long-term deployment — this is meant to be started, used, and stopped
- If you need multiple users or permissions

> Only run it while you need it, and never expose it to the public internet without putting auth in front of it.

## License

MIT License — Copyright (c) Fayaz Bin Salam. See [LICENSE](LICENSE) for the full text.

## Contributing

Contributions are warmly welcomed and greatly appreciated! Whether it's a bug fix, new feature, or improvement, your input helps make this project better for everyone.

Before submitting a pull request, please:

1. Create an issue describing the feature or bug fix you'd like to work on
2. Wait for discussion and approval to ensure alignment with project goals
3. Fork the repository and create your feature branch
4. Submit your pull request with a clear description of changes

This approach helps avoid duplicate efforts and ensures smooth collaboration. Thank you for considering contributing!

## Share

Sharing this repository with your friends is just one click away from here

[![facebook](https://user-images.githubusercontent.com/6418354/179013321-ac1d1452-0689-493f-9066-940cf2302b6e.png)](https://www.facebook.com/sharer/sharer.php?u=https://github.com/p32929/node_file_manager_server/)
[![twitter](https://user-images.githubusercontent.com/6418354/179013351-7d8d6d1c-4ce2-46ab-bef8-4c4765a1b888.png)](https://twitter.com/intent/tweet?url=https://github.com/p32929/node_file_manager_server/)
[![tumblr](https://user-images.githubusercontent.com/6418354/179013343-3111f55a-3b90-40c7-8487-9777348672b0.png)](https://www.tumblr.com/share?v=3&u=https://github.com/p32929/node_file_manager_server/)
[![pocket](https://user-images.githubusercontent.com/6418354/179013334-b095c45f-becf-49f4-9ee1-5a731a9b1f85.png)](https://getpocket.com/save?url=https://github.com/p32929/node_file_manager_server/)
[![pinterest](https://user-images.githubusercontent.com/6418354/179013331-44cd9206-11b1-4b65-becb-5863b61c828f.png)](https://pinterest.com/pin/create/button/?url=https://github.com/p32929/node_file_manager_server/)
[![reddit](https://user-images.githubusercontent.com/6418354/179013338-7416ae3f-73ba-4522-86e1-1374d7082d22.png)](https://www.reddit.com/submit?url=https://github.com/p32929/node_file_manager_server/)
[![linkedin](https://user-images.githubusercontent.com/6418354/179013327-ca7b7102-1da8-4b1c-858f-1a6e5f21bd70.png)](https://www.linkedin.com/shareArticle?mini=true&url=https://github.com/p32929/node_file_manager_server/)
[![whatsapp](https://user-images.githubusercontent.com/6418354/179013353-f477fa0b-3e6f-4138-a357-c9991b23ff88.png)](https://api.whatsapp.com/send?text=https://github.com/p32929/node_file_manager_server/)

