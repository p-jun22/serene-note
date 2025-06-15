// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCj5-5-prs1YDQRAzgukuR5FUsR6n1dLuc",
  authDomain: "serene-note.firebaseapp.com",
  projectId: "serene-note",
  storageBucket: "serene-note.firebasestorage.app",
  messagingSenderId: "202958092065",
  appId: "1:202958092065:web:0a41ceb976dd8374933060",
  measurementId: "G-BPSP2TDZHK"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db, app}; 