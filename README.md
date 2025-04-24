# File Manager Server

A **lightweight, self-hosted file manager** with **zero external dependencies**. Just **clone the repo, run it with Node.js, and start managing files**—no need to install any extra packages.  

It comes with a **built-in file explorer** so you can **navigate directories to upload and download files** on the system. The **UI is simple and intuitive**, making file transfers effortless.  

# Screenshots

https://github.com/user-attachments/assets/813328ac-4639-4804-a269-c67a0fa2bea6

---

## **Why Use This?**  
✅ **No External Dependencies** – Just **Node.js** and you're ready to go.  
✅ **Quick & Easy Setup** – **Clone & run** without installing anything.  
✅ **Built-in File Explorer** – Navigate and work with your files.  
✅ **File Upload** – Upload files to any directory with real-time progress.  
✅ **File Download** – Download single files or multiple files as a ZIP archive.  
✅ **Grid & List Views** – Choose how you want to see your files.  
✅ **Real-Time Progress** – See **upload speed, remaining time, and progress**.  
✅ **File Type Recognition** – Visual indicators for different file types.  

---

## **When to Use It?**  
- When you need a **fast and hassle-free file manager** without setting up FTP or SSH.  
- If you want a **temporary file transfer tool** for quick uploads and downloads.  
- When you need **full control** over where files get saved and accessed.  

## **When NOT to Use It?**  
- If **security is a concern**, as this has **no authentication** by default.  
- For **long-term deployment**—this is designed for **temporary file management**.  
- If you need **multi-user access** or permissions control.  

---

## **How to Run It?**  
1. **Install Node.js** (if not already installed).  
2. Clone the repository and run the server:  
   ```sh
   node server.js
   ```  
3. Open a browser and go to:  
   ```
   http://<server-ip>:3999
   ```  
4. **Browse directories** to view, download, or upload files.  

---

## **Features:**

### File Downloads
- **Single File Download**: Click the download button next to any file
- **Multi-File Download**: Select multiple files and download them as a ZIP archive
- **File Types**: Files are categorized by type with appropriate icons
- **View Modes**: Switch between grid and list views

### File Uploads
- **Target Selection**: Choose where to save your uploads
- **Chunked Uploads**: Large files are split into chunks for reliable transfers
- **Progress Tracking**: Monitor upload speed and estimated time remaining
- **Cancel Option**: Stop uploads in progress if needed

---

## **Important Notes:**  
- **Only use this tool temporarily**—once done, it's best to stop the server.  
- **Press Ctrl+C** in the terminal to stop the server.  
- If running on a public server, **secure it** before exposing it online.  

This tool is meant for **quick, local file transfers** and is designed for **ease of use with no setup required**. Just **run it and start managing your files—nothing else needed.**