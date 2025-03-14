document.addEventListener('DOMContentLoaded', async () => {
    const videoContainer = document.getElementById('video-container');
    const introVideo = document.getElementById('intro-video');
    const homePage = document.getElementById('home-page');
    const menuGrid = document.querySelector('.gelato-grid');

    let videoSources = [];
    let currentVideoIndex = 0;
    const outOfStockImageURL = 'https://firebasestorage.googleapis.com/v0/b/dolcevitasinage.appspot.com/o/outofstock.png?alt=media&token=803bbfa7-bc4d-45f8-87b7-8ab9dcbc774f';

    // Function to update the menu grid
    function updateMenuGrid(menuItems) {
        menuGrid.innerHTML = '';
        menuItems
            .filter(item => !item.temporarilyUnavailable) // Exclude temporarily unavailable items
            .slice(0, 18).forEach(item => {
                const menuItem = document.createElement('div');
                menuItem.className = 'gelato-card';
                menuItem.innerHTML = `
                    <img src="${item.outOfStock ? outOfStockImageURL : item.imageURL}" alt="${item.name}">
                    <h3>${item.name}</h3>
                `;
                if (item.outOfStock) {
                    menuItem.classList.add('out-of-stock');
                }
                menuGrid.appendChild(menuItem);
            });
    }

    // Fetch and listen to video URLs from Firestore
    db.collection('videos').onSnapshot(snapshot => {
        videoSources = [];
        snapshot.forEach(doc => {
            videoSources.push(doc.data().url);
        });
        // Start playing videos if not already started
        if (videoSources.length > 0 && introVideo.src === '') {
            playNextVideo();
        }
    });

    // Fetch and listen to menu items from Firestore
    db.collection('menuItems').onSnapshot(snapshot => {
        const menuItems = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            menuItems.push({
                name: data.name,
                imageURL: data.imageURL,
                outOfStock: data.outOfStock || false, // Default to false if not present
                temporarilyUnavailable: data.temporarilyUnavailable || false // Default to false if not present
            });
        });
        updateMenuGrid(menuItems);
    });

    function playNextVideo() {
        if (videoSources.length > 0) {
            introVideo.src = videoSources[currentVideoIndex];
            introVideo.play();
            currentVideoIndex = (currentVideoIndex + 1) % videoSources.length;
            videoContainer.style.display = 'block';
            homePage.style.display = 'none';
        }
    }

    function showMenu() {
        videoContainer.style.display = 'none';
        homePage.style.display = 'block';
        setTimeout(playNextVideo, 45000); // Show menu for 45 seconds before playing next video
    }

    introVideo.addEventListener('ended', showMenu);

    // Start the first video if sources are already available
    if (videoSources.length > 0) {
        playNextVideo();
    }
});
