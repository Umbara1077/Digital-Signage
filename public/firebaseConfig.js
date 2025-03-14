const firebaseConfig = {
  apiKey: "AIzaSyAQTwB6-NdzeaiqsoeIDCCtWuxf-2oxmIQ",
  authDomain: "dolcevitasinage.firebaseapp.com",
  projectId: "dolcevitasinage",
  storageBucket: "dolcevitasinage.appspot.com",
  messagingSenderId: "525631031898",
  appId: "1:525631031898:web:53dfa013799a41ab1c2663",
  measurementId: "G-KVG4XSLLQZ"
};

firebase.initializeApp(firebaseConfig);

const db = firebase.firestore();
const storage = firebase.storage();
const auth = firebase.auth();


