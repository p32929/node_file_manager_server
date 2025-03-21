# node_file_upload_server 

A **lightweight, self-hosted file upload server** with **zero external dependencies**. Just **clone the repo, run it with Node.js, and start uploading files**—no need to install any extra packages.  

It comes with a **built-in file explorer** so you can **navigate directories and choose exactly where to save files** on the system. The **UI is simple and intuitive**, making file transfers effortless.  

# Screenshots

![Image](https://github.com/user-attachments/assets/733b21de-fb19-4c53-a76b-45a087fb757a)

![Image](https://github.com/user-attachments/assets/9b7520a1-9abc-4717-8aa1-5a1e68dafc30)

---

## **Why Use This?**  
✅ **No External Dependencies** – Just **Node.js** and you're ready to go.  
✅ **Quick & Easy Setup** – **Clone & run** without installing anything.  
✅ **Built-in File Explorer** – Navigate and pick a target folder before uploading.  
✅ **Real-Time Upload Progress** – See **upload speed, remaining time, and progress**.  
✅ **Rename or Replace Duplicates** – Handles existing files smoothly.  

---

## **When to Use It?**  
- When you need a **fast and hassle-free file uploader** without setting up FTP or SSH.  
- If you want a **temporary file upload tool** for quick transfers.  
- When you need **full control** over where files get saved.  

## **When NOT to Use It?**  
- If **security is a concern**, as this has **no authentication** by default.  
- For **long-term deployment**—this is designed for **temporary file transfers**.  
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
   http://<server-ip>:3000
   ```  
4. **Browse directories**, **select a folder**, and **upload your file**.  

---

## **Important Notes:**  
- **Only use this tool temporarily**—once done, it's best to stop the server.  
- **Press Ctrl+C** in the terminal to stop the server.  
- If running on a public server, **secure it** before exposing it online.  

This tool is meant for **quick, local file transfers** and is designed for **ease of use with no setup required**. Just **run it and start uploading—nothing else needed.**