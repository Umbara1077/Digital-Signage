# Digital Signage System  

The Digital Signage System is a web-based display system designed for Dolce Vita Gelateria. This system dynamically manages menu items, promotional videos, and business hours using Firebase Firestore, Authentication, and Storage. It includes an admin panel for updating menu items, managing stock, and handling business hours.  

## Features  

- Dynamic menu and video display using Firebase Firestore  
- Real-time menu updates with stock and availability status  
- Automatic video rotation with seamless transitions  
- Business hour-based access control  
- Admin panel for managing menu, stock, and videos  
- Secure authentication with Firebase Auth  
- Mobile-friendly and responsive design  

## How It Works  

Public Display System (index.html)  

- Loads promotional videos and menu items dynamically  
- Alternates between videos and menu content every 45 seconds  
- Checks business hours and redirects to an Early page if accessed outside business hours  
- Updates menu items in real time from Firestore  

Admin Panel (admin.html)  

- Admins log in securely via Firebase Authentication  
- Manage menu items, update stock status, and add new items  
- Modify business hours directly through the panel  
- Upload, swap, or remove videos from rotation  

## File Overview  

Public Display Files  

- index.html - Displays videos and menu dynamically  
- script.js - Handles video rotation, menu updates, and Firestore integration  
- early.html - Displays a message when accessed outside business hours  
- style.css - Styles for the public display system  

Admin Panel Files  

- admin.html - The admin dashboard for managing signage  
- admin-script.js - Handles menu updates, video uploads, and Firestore communication  
- admin-style.css - Styling for the admin panel  

Authentication and Configuration  

- login.html - Admin login page  
- login.css - Styles for the login page  
- signInScript.js - Handles authentication logic  
- firebaseConfig.js - Firebase configuration file  

## Business Hours Management  

- Business hours are retrieved from Firestore  
- If accessed outside business hours, the system redirects to early.html  
- If accessed within business hours, it displays the menu and videos  
- Admins can update hours in admin.html, and changes apply instantly  

## Video and Menu Management  

Videos  

- Uploaded via admin.html and stored in Firebase Storage  
- Rotated every 45 seconds with the menu display  

Menu Items  

- Pulled from Firestore and displayed dynamically  
- Items marked out of stock show an alternate image  
- Admins can update, remove, or add items in real time  

## Additional Notes  

- Optimized for tablet and large screen displays  
- Admin authentication is required for menu and video management  
- Stock updates and menu changes reflect instantly on the display  
