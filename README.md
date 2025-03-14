Digital Signage System
The Digital Signage System is a web-based display system designed for Dolce Vita Gelateria. This system dynamically manages menu items, promotional videos, and business hours using Firebase Firestore, Authentication, and Storage. It includes an admin panel for updating menu items, managing stock, and handling business hours.

Overview
The signage system includes two key components:

The Public Display System: Displays promotional videos and menu items dynamically, switching between videos and menu content every 45 seconds.
The Admin Panel: Allows authorized users to manage menu items, update stock availability, and replace videos in the system.
The system automatically redirects users to an "Early" page when accessed outside business hours.

Features
Dynamic menu and video display using Firebase Firestore
Real-time menu updates with stock and availability status
Automatic video rotation and seamless transitions
Business hour-based access control
Admin panel for managing menu items, business hours, and videos
Secure authentication system with Firebase Auth
Mobile-friendly and responsive design
How It Works
Public Display System (index.html)
The system loads promotional videos from Firebase Storage.
Videos and menu items are displayed in alternating cycles every 45 seconds.
The system checks business hours and redirects to an "Early" page if accessed outside business hours.
Menu items dynamically update when changed in Firestore.
Admin Panel (admin.html)
Admins log in securely via Firebase Authentication.
They can manage menu items, update stock status, and add new items.
Business hours can be modified directly through the panel.
Videos can be uploaded, swapped, or removed from rotation.
File Overview
Public Display Files
index.html - The main page displaying videos and menu content dynamically.
script.js - Handles video rotation, menu updates, and Firestore integration.
early.html - The page displayed when accessed outside business hours.
style.css - Contains all styles for the display system.
Admin Panel Files
admin.html - The admin dashboard for managing the signage system.
admin-script.js - Handles menu updates, video uploads, and Firestore communication.
admin-style.css - Contains styles for the admin panel.
Authentication and Configuration Files
login.html - Admin login page for authentication.
login.css - Styles for the login page.
signInScript.js - Handles authentication logic.
firebaseConfig.js - Configuration file for Firebase authentication and database access.
Business Hours Management
The system retrieves business hours from Firestore.

If accessed outside business hours, it redirects to early.html.
If accessed within business hours, it displays the signage content.
Admins can update hours in admin.html, and the changes apply in real-time.
Video and Menu Management
Videos:

Uploaded via admin.html and stored in Firebase Storage.
They rotate every 45 seconds with the menu display.
Menu Items:

Pulled from Firestore and displayed dynamically.
Items marked out of stock show an alternate image.
Admins can update, remove, or add items in real-time.
Additional Notes
This system is optimized for tablet and large screen displays.
Admin authentication is required to make changes to menu items or videos.
Stock updates and menu changes reflect instantly on the display.
This project enables seamless digital menu management and dynamic promotional content for Dolce Vita Gelateria.
