document.addEventListener('DOMContentLoaded', function() {
    const signInForm = document.getElementById('signInForm');
    const errorMessage = document.getElementById('error-message');

    signInForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        try {
            await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
            await firebase.auth().signInWithEmailAndPassword(email, password);
            console.log("User signed in, redirecting to admin.html");
            window.location.href = 'admin.html'; // Redirect to admin page after successful sign-in
        } catch (error) {
            errorMessage.textContent = error.message;
            console.error("Error during sign-in:", error);
        }
    });

    // Check if user is already signed in and redirect to admin page if authenticated
    firebase.auth().onAuthStateChanged(user => {
        if (user && window.location.pathname.endsWith('login.html')) {
            console.log("User already signed in, redirecting to admin.html");
            window.location.href = 'admin.html';
        }
    });
});

