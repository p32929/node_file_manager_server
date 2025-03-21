# **Node File Upload Server**  

A simple **self-hosted file upload server** that allows you to **upload files to a computer or Linux server** through a web interface. It includes a **file explorer** for browsing system directories and choosing where to save the uploaded file.  

## **When to Use It?**  
- When you need to **quickly transfer files** to a remote server.  
- If you want an **easy way to upload files** without setting up FTP or SSH.  
- When you need a **temporary file upload tool** for quick file transfers.  

## **When NOT to Use It?**  
- If **security is a concern**, as this tool exposes file uploads without authentication.  
- For **permanent deployment**, since it lacks access restrictions.  
- If you need **multiple user support** or role-based permissions.  

## **How to Run It?**  
1. **Install Node.js** on the server or computer.  
2. Run the server:  
   ```sh
   node server.js
   ```  
3. Open a browser and go to:  
   ```
   http://<server-ip>:3000
   ```  
4. Browse directories, select a folder, and upload your file.  

## **Important Notes:**  
- **Only use this tool temporarily.** It is recommended to stop the server after uploading files.  
- To stop it, simply **press Ctrl+C** in the terminal.  
- If using on a public server, **set up authentication** to prevent unauthorized access.  

This is meant for **quick, local file transfers** and **should not be exposed to the internet without security measures**.