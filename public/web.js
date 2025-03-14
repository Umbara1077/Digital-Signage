document.addEventListener('DOMContentLoaded', async () => {
    const menuGrid = document.getElementById('menu-grid');
    const outOfStockImageURL = 'https://firebasestorage.googleapis.com/v0/b/dolcevitasinage.appspot.com/o/outofstock.png?alt=media&token=803bbfa7-bc4d-45f8-87b7-8ab9dcbc774f';

    // Function to update the menu grid
    function updateMenuGrid(menuItems) {
        menuGrid.innerHTML = '';
        menuItems
            .filter(item => !item.temporarilyUnavailable) // Exclude temporarily unavailable items
            .slice(0, 18) // Limit to the first 18 items
            .forEach(item => {
                const menuItem = document.createElement('div');
                menuItem.className = 'gelato-card';

                // Use out-of-stock image if the item is out of stock
                menuItem.innerHTML = `
                    <img src="${item.outOfStock ? outOfStockImageURL : item.imageURL}" alt="${item.name}">
                    <h3>${item.name}</h3>
                `;

                menuGrid.appendChild(menuItem);
            });
    }

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
});