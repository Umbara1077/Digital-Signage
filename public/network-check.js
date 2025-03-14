let wasOffline = false;

async function checkInternet() {
    try {
        const response = await fetch("https://google.com/favicon.ico", { method: "HEAD", mode: "no-cors" });
        return response.ok || response.type === "opaque"; 
    } catch (error) {
        return false;
    }
}

setInterval(async () => {
    const isOnline = await checkInternet();

    if (isOnline) {
        if (wasOffline) { 
            console.log("Internet is back! Refreshing...");
            location.reload();
        }
        wasOffline = false; 
    } else {
        if (!wasOffline) {
            console.log("Internet lost! Waiting for it to return...");
        }
        wasOffline = true; 
    }
}, 60000); 