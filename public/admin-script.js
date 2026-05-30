document.addEventListener('DOMContentLoaded', () => {
    firebase.auth().onAuthStateChanged(user => {
        if (!user) {
            console.warn('Waiting for Firebase Auth…');
            return;
        }

        // *** AUTH IS READY HERE ***
        const storageRef = firebase.storage().ref();
        const db = firebase.firestore();

        // === SNOW TOGGLE
        const snowToggle = document.getElementById('snowToggle');

        if (snowToggle) {
            const snowDocRef = db.collection('signageSettings').doc('snowEffect');

            // Load current value from Firestore
            snowDocRef.get().then(doc => {
                if (doc.exists) {
                    const data = doc.data();
                    // default to true if not set
                    snowToggle.checked = (data.enabled !== false);
                } else {
                    // if doc doesn't exist yet, assume enabled
                    snowToggle.checked = true;
                }
            }).catch(err => {
                console.error('Error loading snow toggle setting:', err);
            });

            // Update Firestore when user clicks the toggle
            snowToggle.addEventListener('change', e => {
                snowDocRef
                    .set({ enabled: e.target.checked }, { merge: true })
                    .catch(err => console.error('Error updating snow toggle:', err));
            });
        }

        // === HEART TOGGLE
        const heartToggle = document.getElementById('heartToggle');

        if (heartToggle) {
            const heartDocRef = db.collection('signageSettings').doc('heartEffect');

            // Load current value from Firestore
            heartDocRef.get().then(doc => {
                if (doc.exists) {
                    const data = doc.data();
                    heartToggle.checked = (data.enabled === true);
                } else {
                    heartToggle.checked = false; // Default off for new feature
                }
            }).catch(err => {
                console.error('Error loading heart toggle setting:', err);
            });

            // Update Firestore when user clicks the toggle
            heartToggle.addEventListener('change', e => {
                heartDocRef
                    .set({ enabled: e.target.checked }, { merge: true })
                    .catch(err => console.error('Error updating heart toggle:', err));
            });
        }

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

            // Store full pending list for search filtering
            window._allPendingItems = pendingItemNames.slice().sort((a, b) => a.localeCompare(b));

            const pendingDropdowns = document.querySelectorAll('.pending-item-name-dropdown');
            pendingDropdowns.forEach(dropdown => {
                dropdown.innerHTML = window._allPendingItems.map(name => `<option value="${name}">${name}</option>`).join('');
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
            const arrangeGrid = document.getElementById('arrangeGrid');
            const menuItemsSnapshot = await db.collection('menuItems').get();
            menuGrid.innerHTML = '';

            // Build sorted list for arrange grid
            const allItems = [];

            menuItemsSnapshot.forEach(doc => {
                const data = doc.data();
                allItems.push({ id: doc.id, ...data });

                const menuItem = document.createElement('div');
                menuItem.className = 'menu-item-card';

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

            // Sort by order field (items without order go to end)
            allItems.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

            // Build arrange grid
            if (arrangeGrid) {
                arrangeGrid.innerHTML = '';
                allItems.forEach((item, idx) => {
                    const card = document.createElement('div');
                    card.className = 'arrange-card';
                    card.draggable = true;
                    card.dataset.id = item.id;
                    card.dataset.index = idx;
                    card.innerHTML = `
                        <span class="arrange-num">${idx + 1}</span>
                        <img src="${item.imageURL}" alt="${item.name}">
                        <span class="arrange-name">${item.name}</span>
                    `;
                    arrangeGrid.appendChild(card);
                });

                // Setup drag and drop
                setupDragAndDrop(arrangeGrid);
            }
        }

        function setupDragAndDrop(grid) {
            let draggedEl = null;

            grid.addEventListener('dragstart', (e) => {
                const card = e.target.closest('.arrange-card');
                if (!card) return;
                draggedEl = card;
                card.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            grid.addEventListener('dragend', (e) => {
                const card = e.target.closest('.arrange-card');
                if (card) card.classList.remove('dragging');
                draggedEl = null;
                // Re-number
                grid.querySelectorAll('.arrange-card').forEach((c, i) => {
                    c.querySelector('.arrange-num').textContent = i + 1;
                    c.dataset.index = i;
                });
            });

            grid.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const afterEl = getDragAfterElement(grid, e.clientY, e.clientX);
                if (afterEl == null) {
                    grid.appendChild(draggedEl);
                } else {
                    grid.insertBefore(draggedEl, afterEl);
                }
            });
        }

        function getDragAfterElement(grid, y, x) {
            const cards = [...grid.querySelectorAll('.arrange-card:not(.dragging)')];
            let closest = { offset: Number.POSITIVE_INFINITY, element: null };

            cards.forEach(card => {
                const box = card.getBoundingClientRect();
                const offsetY = y - box.top - box.height / 2;
                const offsetX = x - box.left - box.width / 2;
                const offset = Math.sqrt(offsetY * offsetY + offsetX * offsetX);

                if (offset < closest.offset) {
                    closest = { offset, element: card };
                }
            });

            // Only return the element if we're before it
            if (closest.element) {
                const box = closest.element.getBoundingClientRect();
                const centerY = box.top + box.height / 2;
                const centerX = box.left + box.width / 2;
                if (y < centerY || (y === centerY && x < centerX)) {
                    return closest.element;
                } else {
                    return closest.element.nextElementSibling;
                }
            }
            return null;
        }

        // === PENDING SEARCH FILTER ===
        const pendingSearchBox = document.getElementById('pendingSearchBox');
        if (pendingSearchBox) {
            pendingSearchBox.addEventListener('input', () => {
                const query = pendingSearchBox.value.toLowerCase().trim();
                const dropdown = document.getElementById('newPendingItemName');
                const allItems = window._allPendingItems || [];
                const filtered = query === '' ? allItems : allItems.filter(name => name.toLowerCase().includes(query));
                dropdown.innerHTML = filtered.map(name => `<option value="${name}">${name}</option>`).join('');
                // Auto-trigger description load for the first match
                if (filtered.length > 0) {
                    dropdown.value = filtered[0];
                    dropdown.dispatchEvent(new Event('change'));
                }
            });
        }

        // === REMOVE FROM MENU ===
        document.getElementById('removeFromMenuForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const itemId = document.getElementById('removeItemName').value;
            const itemDoc = await db.collection('menuItems').doc(itemId).get();

            if (!itemDoc.exists) {
                alert('Item not found.');
                return;
            }

            const itemData = itemDoc.data();
            const confirmRemove = confirm(`Are you sure you want to remove "${itemData.name}" from the menu? It will be moved to pending items.`);
            if (!confirmRemove) return;

            try {
                // Move to pendingItems, then delete from menuItems
                await db.collection('pendingItems').add(itemData);
                await db.collection('menuItems').doc(itemId).delete();
                alert(`"${itemData.name}" has been removed from the menu and moved to pending items.`);
                populateDropdowns();
                displayCurrentMenuItems();
            } catch (error) {
                console.error('Error removing menu item:', error);
                alert('Error removing menu item.');
            }
        });


        // === TOGGLE REMOVE / ADD BACK ===
        document.getElementById('showRemoveMode').addEventListener('click', () => {
            document.getElementById('showRemoveMode').classList.add('active');
            document.getElementById('showAddBackMode').classList.remove('active');
            document.getElementById('removeFromMenuForm').style.display = '';
            document.getElementById('addFromPendingForm').style.display = 'none';
        });
        document.getElementById('showAddBackMode').addEventListener('click', () => {
            document.getElementById('showAddBackMode').classList.add('active');
            document.getElementById('showRemoveMode').classList.remove('active');
            document.getElementById('addFromPendingForm').style.display = '';
            document.getElementById('removeFromMenuForm').style.display = 'none';
        });

        // === ADD BACK FROM PENDING ===
        document.getElementById('addBackSearchBox').addEventListener('input', () => {
            const query = document.getElementById('addBackSearchBox').value.toLowerCase().trim();
            const dropdown = document.getElementById('addBackItemName');
            const allItems = window._allPendingItems || [];
            const filtered = query === '' ? allItems : allItems.filter(name => name.toLowerCase().includes(query));
            dropdown.innerHTML = filtered.map(name => `<option value="${name}">${name}</option>`).join('');
        });

        document.getElementById('addFromPendingForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const pendingName = document.getElementById('addBackItemName').value;
            if (!pendingName) { alert('Please select a pending item.'); return; }

            try {
                const pendingSnapshot = await db.collection('pendingItems').where('name', '==', pendingName).get();
                if (pendingSnapshot.empty) { alert('Pending item not found.'); return; }

                const pendingDoc = pendingSnapshot.docs[0];
                const pendingData = pendingDoc.data();
                if (!confirm(`Add "${pendingData.name}" back to the menu?`)) return;

                await db.collection('menuItems').add(pendingData);
                await db.collection('pendingItems').doc(pendingDoc.id).delete();
                alert(`"${pendingData.name}" has been added back to the menu.`);
                populateDropdowns();
                displayCurrentMenuItems();
            } catch (error) {
                console.error('Error adding item back to menu:', error);
                alert('Error adding item back to menu.');
            }
        });

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

            const itemName = document.getElementById('itemName').value.trim();
            const itemDescription = document.getElementById('itemDescription').value.trim();
            const itemImageFile = document.getElementById('itemImageFile').files[0];      // -> imageURL
            const gelatoImageFile = document.getElementById('gelatoImageFile').files[0];  // -> gelatoImage

            if (!itemImageFile || !gelatoImageFile) {
                alert('Please select both images.');
                return;
            }

            try {
                // refs for each folder
                const imagesRef = storageRef.child('images');
                const gelatoImagesRef = storageRef.child('gelatoImage');

                // upload both in parallel to their correct folders
                const [itemSnap, gelatoSnap] = await Promise.all([
                    imagesRef.child(itemImageFile.name).put(itemImageFile),
                    gelatoImagesRef.child(gelatoImageFile.name).put(gelatoImageFile),
                ]);

                // get URLs
                const [imageURL, gelatoImage] = await Promise.all([
                    itemSnap.ref.getDownloadURL(),
                    gelatoSnap.ref.getDownloadURL(),
                ]);

                await db.collection('pendingItems').add({
                    name: itemName,
                    description: itemDescription,
                    imageURL: imageURL,                   // main image in images/
                    gelatoImage: gelatoImage,              // gelato image in gelatoImage/
                    outOfStock: true,
                    temporarilyUnavailable: false
                });

                alert('Menu item added to pending items successfully');
                document.getElementById('addMenuItemForm').reset();
                if (typeof populateDropdowns === 'function') populateDropdowns();

            } catch (error) {
                console.error('Error adding menu item: ', error);
                alert('Failed to add menu item. Check console for details.');
            }

        });

        document.getElementById('replaceMenuItemForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const currentItemId = document.getElementById('currentItemName').value; // Use document ID
            const newPendingItemName = document.getElementById('newPendingItemName').value;
            const newItemImageFile = document.getElementById('newItemImageFile').files[0];

            try {
                // Get the pending item data
                const pendingItemsSnapshot = await db.collection('pendingItems').where('name', '==', newPendingItemName).get();
                if (!pendingItemsSnapshot.empty) {
                    const pendingItemDoc = pendingItemsSnapshot.docs[0];
                    const pendingItemDetails = pendingItemDoc.data();

                    // DEBUG: log the pending item details
                    console.log("Pending item details:", pendingItemDetails);
                    console.log("Pending item has gelatoImage?", pendingItemDetails.hasOwnProperty('gelatoImage'));

                    let newImageURL = pendingItemDetails.imageURL;

                    if (newItemImageFile) {
                        const newImageRef = storageRef.child('images/' + newItemImageFile.name);
                        const snapshot = await newImageRef.put(newItemImageFile);
                        newImageURL = await snapshot.ref.getDownloadURL();
                    }

                    const currentItemDocRef = db.collection('menuItems').doc(currentItemId);
                    const currentItemDoc = await currentItemDocRef.get();

                    if (currentItemDoc.exists) {
                        const currentItemDetails = currentItemDoc.data();

                        console.log("Current menu item details:", currentItemDetails);
                        console.log("Current item has gelatoImage?", currentItemDetails.hasOwnProperty('gelatoImage'));

                        await db.runTransaction(async (transaction) => {
                            const pendingItemData = pendingItemDoc.data();

                            const menuItemUpdate = { ...pendingItemData, imageURL: newImageURL };
                            delete menuItemUpdate.id;

                            console.log("Updating menu item with:", menuItemUpdate);
                            console.log("Update includes gelatoImage?", menuItemUpdate.hasOwnProperty('gelatoImage'));

                            transaction.update(currentItemDocRef, menuItemUpdate);

                            const oldItemData = { ...currentItemDetails };
                            transaction.delete(pendingItemDoc.ref);
                            transaction.set(db.collection('pendingItems').doc(), oldItemData);

                            console.log("Transaction complete - items should be swapped with all fields preserved");
                        });

                        setTimeout(async () => {
                            const updatedMenuItemDoc = await currentItemDocRef.get();
                            console.log("AFTER UPDATE - Menu item:", updatedMenuItemDoc.data());
                            console.log("AFTER UPDATE - Does menu item have gelatoImage?",
                                updatedMenuItemDoc.data().hasOwnProperty('gelatoImage'));
                        }, 1000);

                        alert('Menu item replaced successfully');
                        document.getElementById('replaceMenuItemForm').reset();
                        // Initial population of dropdowns and menu display
                        populateDropdowns();
                        displayCurrentMenuItems();

                        // Real-time listener for pending items changes
                        db.collection('pendingItems').onSnapshot(() => {
                            populateDropdowns();
                        });

                        // Real-time listener for menu items changes
                        db.collection('menuItems').onSnapshot(() => {
                            populateDropdowns();
                            displayCurrentMenuItems();
                        });
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

        let currentVideos = [];

        function getCleanVideoName(videoURL) {
            const fullName = videoURL.split('/').pop().split('?')[0];
            return decodeURIComponent(fullName);
        }

        function updateCurrentVideos(snapshot) {
            const videoSelect = document.getElementById('videoToManage');
            videoSelect.innerHTML = '';
            currentVideos = [];

            snapshot.forEach(doc => {
                const videoURL = doc.data().url;
                const videoName = getCleanVideoName(videoURL);
                const option = document.createElement('option');
                option.value = doc.id;
                option.textContent = videoName;
                videoSelect.appendChild(option);
                currentVideos.push(videoName);
            });
        }


        db.collection('videos').onSnapshot(snapshot => {
            updateCurrentVideos(snapshot);
        });


        async function displayAvailableVideos() {
            const storageVideoSelect = document.getElementById('existingVideoInStorage');
            storageVideoSelect.innerHTML = '<option value="">Select a video from storage</option>';

            const videoFiles = await storageRef.child('videos/').listAll();
            videoFiles.items.forEach(async (videoRef) => {
                const videoName = getCleanVideoName(videoRef.name);

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

        // === SAVE ARRANGE ORDER ===
        document.getElementById('saveOrderBtn').addEventListener('click', async () => {
            const cards = document.querySelectorAll('#arrangeGrid .arrange-card');
            const btn = document.getElementById('saveOrderBtn');
            btn.textContent = 'Saving...';
            btn.disabled = true;

            try {
                const batch = db.batch();
                cards.forEach((card, index) => {
                    const docRef = db.collection('menuItems').doc(card.dataset.id);
                    batch.update(docRef, { order: index });
                });
                await batch.commit();
                btn.textContent = 'Saved!';
                setTimeout(() => {
                    btn.textContent = 'Save Order';
                    btn.disabled = false;
                }, 1500);
            } catch (error) {
                console.error('Error saving order:', error);
                alert('Error saving order.');
                btn.textContent = 'Save Order';
                btn.disabled = false;
            }
        });
    });
});
