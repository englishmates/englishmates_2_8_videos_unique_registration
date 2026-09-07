importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCFuF2PBq09cKOHBuoLDoypEgrI1gSmm4c",
  authDomain: "englishmates-ratangarh-933f1.firebaseapp.com",
  projectId: "englishmates-ratangarh-933f1",
  storageBucket: "englishmates-ratangarh-933f1.firebasestorage.app",
  messagingSenderId: "501474121790",
  appId: "1:501474121790:web:5097a43a6be4e7bc07996f6"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || payload.data?.title || "New Englishmates Admission";
  const options = {
    body: payload.notification?.body || payload.data?.body || "A student has registered on Englishmates.",
    icon: "/bhagirath-dayma-profile.png",
    badge: "/bhagirath-dayma-profile.png",
    data: { url: "/" }
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then((clientList)=>{
    for (const client of clientList) {
      if ('focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow('/');
  }));
});
