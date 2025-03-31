const myFirebaseConfig = {
    apiKey: "AIzaSyAf_4ZVV4m4VSQ0OPp7PyICyaRP8zUOZro",
    authDomain: "auth-d83c4.firebaseapp.com",
    projectId: "auth-d83c4",
    storageBucket: "auth-d83c4.appspot.com",
    messagingSenderId: "740417341364",
    appId: "1:740417341364:web:cf6bc05ba82bc1e5ca94e1"
  };

const myFirebaseApp = firebase.initializeApp(myFirebaseConfig);
const myDb = myFirebaseApp.firestore();
const myAuth = myFirebaseApp.auth();