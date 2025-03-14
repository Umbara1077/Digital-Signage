document.addEventListener('DOMContentLoaded', async () => {
    const storageRef = firebase.storage().ref();
    const db = firebase.firestore();

    async function populateDropdowns() {
        const menuItemsSnapshot = await db.collection('menuItems').get();
        const pendingItemsSnapshot = await db.collection('pendingItems').get();
    
        const itemNames = [];
        const pendingItemNames = [];
        const imageUrls = [];
    
        menuItemsSnapshot.forEach(doc => {
            const data = doc.data();
            itemNames.push({ id: doc.id, name: data.name, temporarilyUnavailable: data.temporarilyUnavailable || false });
            imageUrls.push({ name: data.name, url: data.imageURL });
        });
    
        pendingItemsSnapshot.forEach(doc => {
            const data = doc.data();
            pendingItemNames.push(data.name);
            imageUrls.push({ name: data.name, url: data.imageURL });
        });
    
        const dropdowns = document.querySelectorAll('.item-name-dropdown');
        dropdowns.forEach(dropdown => {
            dropdown.innerHTML = itemNames.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
        });
    
        const pendingDropdowns = document.querySelectorAll('.pending-item-name-dropdown');
        pendingDropdowns.forEach(dropdown => {
            dropdown.innerHTML = pendingItemNames.map(name => `<option value="${name}">${name}</option>`).join('');
        });
    
        const existingImageDropdowns = document.querySelectorAll('#existingItemImageReplace');
        existingImageDropdowns.forEach(dropdown => {
            dropdown.innerHTML = imageUrls.map(image => `<option value="${image.url}">${image.name}</option>`).join('');
        });
    
        // Populate "Temporarily Unavailable" dropdown for each item
        const tempAvailabilityDropdown = document.getElementById('tempAvailabilityItemName');
        tempAvailabilityDropdown.innerHTML = itemNames.map(item => `<option value="${item.id}" ${item.temporarilyUnavailable ? 'selected' : ''}>${item.name}</option>`).join('');
    }
    
    async function displayCurrentMenuItems() {
        const menuGrid = document.querySelector('.current-menu-grid');
        const menuItemsSnapshot = await db.collection('menuItems').get();
        menuGrid.innerHTML = '';
    
        menuItemsSnapshot.forEach(doc => {
            const data = doc.data();
            const menuItem = document.createElement('div');
            menuItem.className = 'menu-item-card';
    
            // Determine item status text based on availability fields
            let statusText = 'In Stock';
            if (data.outOfStock) statusText = 'Out of Stock';
            if (data.temporarilyUnavailable) statusText = 'Temporarily Unavailable';
    
            menuItem.innerHTML = `
                <img src="${data.imageURL}" alt="${data.name}">
                <h3>${data.name}</h3>
                <p>${data.description}</p>
                <p>${statusText}</p>
            `;
    
            menuGrid.appendChild(menuItem);
        });
    }
    
    async function getPendingItemDetails(name) {
        const pendingItemsSnapshot = await db.collection('pendingItems').where('name', '==', name).get();
        if (!pendingItemsSnapshot.empty) {
            const doc = pendingItemsSnapshot.docs[0];
            return { id: doc.id, ...doc.data() };
        }
        return null;
    }

    document.getElementById('newPendingItemName').addEventListener('change', async (e) => {
        const pendingItemDetails = await getPendingItemDetails(e.target.value);
        if (pendingItemDetails) {
            document.getElementById('newItemDescription').value = pendingItemDetails.description;
            document.getElementById('existingItemImageReplace').value = pendingItemDetails.imageURL;
            document.getElementById('existingItemImageReplace').style.display = 'block';
        }
    });

    document.getElementById('addVideoForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const videoFile = document.getElementById('videoFile').files[0];
        const videoRef = storageRef.child('videos/' + videoFile.name);

        try {
            const snapshot = await videoRef.put(videoFile);
            const videoURL = await snapshot.ref.getDownloadURL();
            await db.collection('videos').add({ url: videoURL });
            alert('Video uploaded and added successfully');
            document.getElementById('addVideoForm').reset();
        } catch (error) {
            console.error('Error uploading video: ', error);
        }
    });

    document.getElementById('addMenuItemForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const itemName = document.getElementById('itemName').value;
        const itemDescription = document.getElementById('itemDescription').value;
        const itemImageFile = document.getElementById('itemImageFile').files[0];

        const imageRef = storageRef.child('images/' + itemImageFile.name);
        try {
            const snapshot = await imageRef.put(itemImageFile);
            const imageURL = await snapshot.ref.getDownloadURL();
            await db.collection('pendingItems').add({
                name: itemName,
                description: itemDescription,
                imageURL: imageURL
            });
            alert('Menu item added to pending items successfully');
            document.getElementById('addMenuItemForm').reset();
            populateDropdowns();
        } catch (error) {
            console.error('Error adding menu item: ', error);
        }
    });

    document.getElementById('replaceMenuItemForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentItemId = document.getElementById('currentItemName').value; // Use document ID
        const newPendingItemName = document.getElementById('newPendingItemName').value;
        const newItemImageFile = document.getElementById('newItemImageFile').files[0];
    
        try {
            const pendingItemDetails = await getPendingItemDetails(newPendingItemName);
            if (pendingItemDetails) {
                let newImageURL = pendingItemDetails.imageURL;
    
                if (newItemImageFile) {
                    const newImageRef = storageRef.child('images/' + newItemImageFile.name);
                    const snapshot = await newImageRef.put(newItemImageFile);
                    newImageURL = await snapshot.ref.getDownloadURL();
                }
    
                // Access the document by ID
                const currentItemDocRef = db.collection('menuItems').doc(currentItemId);
                const currentItemDoc = await currentItemDocRef.get();
    
                if (currentItemDoc.exists) {
                    const currentItemDetails = currentItemDoc.data();
                    
                    await currentItemDocRef.update({
                        name: pendingItemDetails.name,
                        description: pendingItemDetails.description,
                        imageURL: newImageURL
                    });
    
                    await db.collection('pendingItems').doc(pendingItemDetails.id).delete();
                    await db.collection('pendingItems').add({
                        name: currentItemDetails.name,
                        description: currentItemDetails.description,
                        imageURL: currentItemDetails.imageURL
                    });
                    alert('Menu item replaced successfully');
                    document.getElementById('replaceMenuItemForm').reset();
                    populateDropdowns();
                    displayCurrentMenuItems();
                } else {
                    alert('Menu item not found');
                }
            } else {
                alert('Pending item not found');
            }
        } catch (error) {
            console.error('Error replacing menu item: ', error);
            alert('Error replacing menu item.');
        }
    });    

    document.getElementById('updateStockStatusForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const itemId = document.getElementById('stockItemName').value; // Use document ID
        const stockStatus = document.getElementById('stockStatus').value;
        const outOfStock = stockStatus === 'outOfStock';
    
        try {
            // Directly access the document by its ID
            await db.collection('menuItems').doc(itemId).update({
                outOfStock: outOfStock
            });
            alert(`Menu item marked as ${stockStatus.replace(/([A-Z])/g, ' $1').toLowerCase()} successfully`);
            document.getElementById('updateStockStatusForm').reset();
            displayCurrentMenuItems();
        } catch (error) {
            console.error('Error updating stock status: ', error);
            alert('Error updating stock status.');
        }
    });    

    document.getElementById('toggleTemporaryAvailabilityForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const itemId = document.getElementById('tempAvailabilityItemName').value;
        const isTemporarilyUnavailable = document.getElementById('tempAvailabilityStatus').checked;
    
        try {
            await db.collection('menuItems').doc(itemId).update({
                temporarilyUnavailable: isTemporarilyUnavailable
            });
            alert(`Item has been ${isTemporarilyUnavailable ? 'marked as' : 'removed from'} temporarily unavailable.`);
            populateDropdowns(); // Refresh dropdowns to reflect the change
            displayCurrentMenuItems(); // Refresh the menu items display
        } catch (error) {
            console.error('Error updating temporary availability:', error);
        }
    });

    document.getElementById('directAddMenuItemForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const itemName = document.getElementById('directItemName').value;
        const itemDescription = document.getElementById('directItemDescription').value;
        const itemImageFile = document.getElementById('directItemImageFile').files[0];

        const imageRef = storageRef.child('images/' + itemImageFile.name);
        try {
            const snapshot = await imageRef.put(itemImageFile);
            const imageURL = await snapshot.ref.getDownloadURL();
            await db.collection('menuItems').add({
                name: itemName,
                description: itemDescription,
                imageURL: imageURL
            });
            alert('Menu item added directly to menu successfully');
            document.getElementById('directAddMenuItemForm').reset();
            populateDropdowns();
            displayCurrentMenuItems();
        } catch (error) {
            console.error('Error adding menu item directly: ', error);
        }
    });

    let currentVideos = []; // Store videos currently in rotation

    function getCleanVideoName(videoURL) {
        const fullName = videoURL.split('/').pop().split('?')[0]; // Extract name from URL
        return decodeURIComponent(fullName); // Decode URL-encoded characters
    }

    // Function to display current video names in the dropdown
    function updateCurrentVideos(snapshot) {
        const videoSelect = document.getElementById('videoToManage');
        videoSelect.innerHTML = '';
        currentVideos = []; // Reset current videos array

        snapshot.forEach(doc => {
            const videoURL = doc.data().url;
            const videoName = getCleanVideoName(videoURL); // Extract clean name
            const option = document.createElement('option');
            option.value = doc.id;
            option.textContent = videoName; // Only show the cleaned-up name
            videoSelect.appendChild(option);
            currentVideos.push(videoName); // Store the video name to filter out later
        });
    }

    // Real-time listener for current videos from Firestore
    db.collection('videos').onSnapshot(snapshot => {
        updateCurrentVideos(snapshot);
    });

    // Function to display all available videos in storage that are NOT in current rotation
    async function displayAvailableVideos() {
        const storageVideoSelect = document.getElementById('existingVideoInStorage');
        storageVideoSelect.innerHTML = '<option value="">Select a video from storage</option>';
        
        const videoFiles = await storageRef.child('videos/').listAll();
        videoFiles.items.forEach(async (videoRef) => {
            const videoName = getCleanVideoName(videoRef.name); 
            
            // Only show videos that are not in the currentVideos array
            if (!currentVideos.includes(videoName)) {
                const videoURL = await videoRef.getDownloadURL(); 
                const option = document.createElement('option');
                option.value = videoURL; 
                option.textContent = videoName; 
                storageVideoSelect.appendChild(option);
            }
        });
    }

    displayAvailableVideos();

    // Remove or Swap video based on button clicked
    document.getElementById('videoActionsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const videoId = document.getElementById('videoToManage').value;
        const newVideoFile = document.getElementById('newVideoFile').files[0];
        const selectedStorageVideo = document.getElementById('existingVideoInStorage').value;

        try {
            if (e.submitter.id === 'removeVideoButton') {
                // Remove video from Firestore
                await db.collection('videos').doc(videoId).delete();
                alert('Video removed successfully');
            } else if (e.submitter.id === 'swapVideoButton') {
                let newVideoURL = '';

                // Swap with a new uploaded video
                if (newVideoFile) {
                    const videoRef = storageRef.child('videos/' + newVideoFile.name);
                    const snapshot = await videoRef.put(newVideoFile);
                    newVideoURL = await snapshot.ref.getDownloadURL();
                } 
                // Swap with an existing video from storage
                else if (selectedStorageVideo) {
                    newVideoURL = selectedStorageVideo;
                } else {
                    alert('Please upload a new video or select one from storage.');
                    return;
                }

                // Update video URL in Firestore
                await db.collection('videos').doc(videoId).update({ url: newVideoURL });
                alert('Video swapped successfully');
            }

            // Reset form and update display
            document.getElementById('videoActionsForm').reset();
            displayCurrentVideos(); 
            displayAvailableVideos();
        } catch (error) {
            console.error('Error managing videos: ', error);
        }
    });

    // Initial population of dropdowns and menu display
    populateDropdowns();
    displayCurrentMenuItems();
});