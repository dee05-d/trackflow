import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import {
    getFirestore,
    doc,
    getDoc,
    updateDoc,
    Timestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

import {
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";


// ============================================================
// FIREBASE
// ============================================================

const firebaseConfig = {
    apiKey: "AIzaSyCrr3ScqMLVI0U4DEbs6BI0W5PmfNejKuU",
    authDomain: "trackflow-d1adf.firebaseapp.com",
    projectId: "trackflow-d1adf",
    storageBucket: "trackflow-d1adf.firebasestorage.app",
    messagingSenderId: "984165931433",
    appId: "1:984165931433:web:e5e74357e39ccf259a0cb8"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);


// ============================================================
// ADMIN CONFIGURATION
// ============================================================

// IMPORTANT: use the SAME email in firestore.rules.
const ADMIN_EMAIL = "deefrosh101@gmail.com";


// ============================================================
// STATE
// ============================================================

let loadedPackage = null;
let simulationState = null;
let refreshTimer = null;

let adminMap = null;
let adminRouteLine = null;
let adminRoute = [];
let adminShipmentMarker = null;
let adminMapDragging = false;


// ============================================================
// DOM
// ============================================================

const loginPanel = document.getElementById("loginPanel");
const controlPanel = document.getElementById("controlPanel");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const controlMessage = document.getElementById("controlMessage");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const trackingNumberInput = document.getElementById("trackingNumberInput");
const loadButton = document.getElementById("loadButton");
const pauseButton = document.getElementById("pauseButton");
const resumeButton = document.getElementById("resumeButton");
const signOutButton = document.getElementById("signOutButton");
const adminMapElement = document.getElementById("adminMap");
const mapProgressValue = document.getElementById("mapProgressValue");
const mapLocationValue = document.getElementById("mapLocationValue");
const mapControlMode = document.getElementById("mapControlMode");

// ============================================================
// AUTH
// ============================================================

onAuthStateChanged(auth, async user => {

    if (!user) {
        loginPanel.classList.remove("hidden");
        controlPanel.classList.add("hidden");
        stopRefreshTimer();
        return;
    }

    if (user.email?.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        await signOut(auth);
        showLoginMessage("This account is not authorized for TrackFlow Control.", true);
        return;
    }

    // IMPORTANT: Do not block the admin panel based on email verification.
    // The Firestore rules below authorize this specific Firebase Auth UID.

    loginPanel.classList.add("hidden");
    controlPanel.classList.remove("hidden");

    await loadPackage();
});


loginForm.addEventListener("submit", async event => {
    event.preventDefault();

    showLoginMessage("Signing in…", false);

    try {
        await signInWithEmailAndPassword(
            auth,
            emailInput.value.trim(),
            passwordInput.value
        );
    } catch (error) {
        console.error(error);
        showLoginMessage(authErrorMessage(error), true);
    }
});


signOutButton.addEventListener("click", async () => {
    await signOut(auth);
});

loadButton.addEventListener("click", loadPackage);

trackingNumberInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        loadPackage();
    }
});

pauseButton.addEventListener("click", pauseSimulation);
resumeButton.addEventListener("click", resumeSimulation);


// ============================================================
// LOAD PACKAGE
// ============================================================

async function loadPackage() {

    const trackingNumber = trackingNumberInput.value.trim().toUpperCase();

    if (!trackingNumber) {
        showControlMessage("Enter a tracking number.", true);
        return;
    }

    showControlMessage("Loading shipment…", false);

    try {
        const packageRef = doc(db, "packages", trackingNumber);
        const snapshot = await getDoc(packageRef);

        if (!snapshot.exists()) {
            loadedPackage = null;
            simulationState = null;
            updateControlUI();
            showControlMessage("Tracking number not found.", true);
            return;
        }

        loadedPackage = {
            id: snapshot.id,
            ...snapshot.data()
        };

        const storedSimulation = loadedPackage.simulation || null;
        const needsSimulationRepair = !isValidSimulationState(storedSimulation);

        if (needsSimulationRepair) {
            console.warn(
                "TrackFlow: stored simulation is missing or invalid. Building a local initial state."
            );

            simulationState = createInitialSimulationState(loadedPackage);

            loadedPackage = {
                ...loadedPackage,
                simulation: simulationState
            };
        } else {
            simulationState = storedSimulation;
        }

        // IMPORTANT: Initialize the control panel and map BEFORE attempting
        // to persist a repaired simulation. A denied write must not destroy
        // the admin UI or prevent the map from appearing.
        updateControlUI();
        initializeAdminMap();
        renderAdminMap();
        startRefreshTimer();

        if (needsSimulationRepair) {
            try {
                await updateDoc(packageRef, {
                    simulation: toFirestoreSimulation(simulationState)
                });

                showControlMessage(
                    "Shipment loaded and simulation synchronized.",
                    false
                );
            } catch (repairError) {
                console.error("TrackFlow simulation repair failed:", repairError);

                showControlMessage(
                    repairError.code === "permission-denied"
                        ? "Shipment loaded, but Firebase denied the simulation update. Check the deployed Firestore rules."
                        : "Shipment loaded, but the simulation could not be synchronized.",
                    true
                );
            }
        } else {
            showControlMessage("Shipment loaded.", false);
        }

    } catch (error) {
        console.error(error);
        showControlMessage(
            error.code === "permission-denied"
                ? "Permission denied. Check Firebase Auth and Firestore rules."
                : "Unable to load the shipment.",
            true
        );
    }
}

// ============================================================
// SIMULATION STATE VALIDATION
// ============================================================

function isValidSimulationState(state) {

    if (!state || typeof state !== "object") {
        return false;
    }

    const departure =
        parseTrackFlowDate(
            state.virtualDepartureTime
        );

    const delivery =
        parseTrackFlowDate(
            state.virtualDeliveryTime
        );

    const progress =
        Number(state.progress);

    if (!departure || !delivery) {
        return false;
    }

    if (
        !Number.isFinite(progress) ||
        progress < 0 ||
        progress > 1
    ) {
        return false;
    }

    if (
        delivery.getTime() <=
        departure.getTime()
    ) {
        return false;
    }

    return true;
}


// ============================================================
// INITIAL SIMULATION STATE
// ============================================================

function createInitialSimulationState(packageData) {

    const departure = parseTrackFlowDate(packageData.departureTime);
    const delivery = parseTrackFlowDate(packageData.estimatedDeliveryTime);
    const now = new Date();

    if (!departure || !delivery || delivery <= departure) {
        throw new Error("Invalid departure or delivery time.");
    }

    const progress = calculateDateProgress(
        departure,
        delivery,
        now
    );

    return {
        paused: false,
        progress,
        virtualDepartureTime: departure,
        virtualDeliveryTime: delivery,
        updatedAt: now,
        pausedAt: null
    };
}


// ============================================================
// PAUSE
// ============================================================

async function pauseSimulation() {

    if (!loadedPackage) {
        showControlMessage("Load a shipment first.", true);
        return;
    }

    if (!simulationState || simulationState.paused) {
        return;
    }

    try {
        setButtonsBusy(true);

        const packageRef = doc(db, "packages", loadedPackage.id);
        const freshSnapshot = await getDoc(packageRef);

        if (!freshSnapshot.exists()) {
            throw new Error("Shipment no longer exists.");
        }

        const freshPackage = freshSnapshot.data();
let freshState =
    freshPackage.simulation;

if (
    !isValidSimulationState(
        freshState
    )
) {

    freshState =
        createInitialSimulationState(
            freshPackage
        );

    await updateDoc(
        packageRef,
        {
            simulation:
                toFirestoreSimulation(
                    freshState
                )
        }
    );
}

        const now = new Date();
        const virtualDeparture = parseTrackFlowDate(freshState.virtualDepartureTime);
        const virtualDelivery = parseTrackFlowDate(freshState.virtualDeliveryTime);

        if (!virtualDeparture || !virtualDelivery) {
            throw new Error("Simulation clock is invalid.");
        }

        const progress = freshState.paused
            ? clamp(Number(freshState.progress))
            : calculateDateProgress(
                virtualDeparture,
                virtualDelivery,
                now
            );

        await updateDoc(packageRef, {
            simulation: {
                paused: true,
                progress,
                virtualDepartureTime: Timestamp.fromDate(virtualDeparture),
                virtualDeliveryTime: Timestamp.fromDate(virtualDelivery),
                updatedAt: Timestamp.fromDate(now),
                pausedAt: Timestamp.fromDate(now)
            }
        });

        simulationState = {
            ...freshState,
            paused: true,
            progress,
            virtualDepartureTime: virtualDeparture,
            virtualDeliveryTime: virtualDelivery,
            updatedAt: now,
            pausedAt: now
        };

        updateControlUI();
        showControlMessage("Shipment placed on hold. Its position and schedule are frozen.", false);

    } catch (error) {
        console.error(error);
        showControlMessage(
            error.code === "permission-denied"
                ? "Pause denied by Firestore rules."
                : error.message || "Unable to pause shipment.",
            true
        );
    } finally {
        setButtonsBusy(false);
    }
}


// ============================================================
// RESUME
// ============================================================

async function resumeSimulation() {

    if (!loadedPackage) {
        showControlMessage("Load a shipment first.", true);
        return;
    }

    if (!simulationState || !simulationState.paused) {
        return;
    }

    const progress = clamp(Number(simulationState.progress));

    if (progress >= 1) {
        showControlMessage("This shipment is already delivered.", true);
        return;
    }

    try {
        setButtonsBusy(true);

        const packageRef = doc(db, "packages", loadedPackage.id);
        const freshSnapshot = await getDoc(packageRef);

        if (!freshSnapshot.exists()) {
            throw new Error("Shipment no longer exists.");
        }

let freshState =
    freshSnapshot.data().simulation;

if (
    !isValidSimulationState(
        freshState
    )
) {

    freshState =
        createInitialSimulationState(
            freshSnapshot.data()
        );

    await updateDoc(
        packageRef,
        {
            simulation:
                toFirestoreSimulation(
                    freshState
                )
        }
    );
}

if (!freshState.paused) {
            simulationState = freshState || null;
            updateControlUI();
            showControlMessage("Shipment is already running.", false);
            return;
        }

        const pausedProgress = clamp(Number(freshState.progress));
        const oldDeparture = parseTrackFlowDate(freshState.virtualDepartureTime);
        const oldDelivery = parseTrackFlowDate(freshState.virtualDeliveryTime);

        if (!oldDeparture || !oldDelivery || oldDelivery <= oldDeparture) {
            throw new Error("Simulation clock is invalid.");
        }

        const duration = oldDelivery.getTime() - oldDeparture.getTime();
        const now = new Date();

        // Preserve the exact progress and shift the remaining schedule
        // forward. Time spent paused is therefore never counted as travel.
        const newDeparture = new Date(
            now.getTime() - duration * pausedProgress
        );

        const newDelivery = new Date(
            now.getTime() + duration * (1 - pausedProgress)
        );

        await updateDoc(packageRef, {
            simulation: {
                paused: false,
                progress: pausedProgress,
                virtualDepartureTime: Timestamp.fromDate(newDeparture),
                virtualDeliveryTime: Timestamp.fromDate(newDelivery),
                updatedAt: Timestamp.fromDate(now),
                pausedAt: null
            }
        });

        simulationState = {
            paused: false,
            progress: pausedProgress,
            virtualDepartureTime: newDeparture,
            virtualDeliveryTime: newDelivery,
            updatedAt: now,
            pausedAt: null
        };

        updateControlUI();
        showControlMessage("Shipment resumed from the exact paused position. Delivery schedule realigned.", false);

    } catch (error) {
        console.error(error);
        showControlMessage(
            error.code === "permission-denied"
                ? "Resume denied by Firestore rules."
                : error.message || "Unable to resume shipment.",
            true
        );
    } finally {
        setButtonsBusy(false);
    }
}


// ============================================================
// LIVE ADMIN DISPLAY
// ============================================================

function startRefreshTimer() {
    stopRefreshTimer();

    refreshTimer = setInterval(async () => {
        if (!loadedPackage) return;

        try {
            const snapshot = await getDoc(
                doc(db, "packages", loadedPackage.id)
            );

            if (!snapshot.exists()) return;

            loadedPackage = {
                id: snapshot.id,
                ...snapshot.data()
            };

simulationState =
    loadedPackage.simulation || null;

// If another admin action, an old document,
// or a malformed Firestore value leaves the
// simulation invalid, repair it automatically.
if (
    !isValidSimulationState(
        simulationState
    )
) {

    try {

        simulationState =
            createInitialSimulationState(
                loadedPackage
            );

        await updateDoc(
            doc(
                db,
                "packages",
                loadedPackage.id
            ),
            {
                simulation:
                    toFirestoreSimulation(
                        simulationState
                    )
            }
        );

        loadedPackage = {
            ...loadedPackage,
            simulation:
                simulationState
        };

    } catch (repairError) {

        console.error(
            "Unable to repair simulation:",
            repairError
        );
    }
}

updateControlUI();
        } catch (error) {
            console.error("Admin refresh error:", error);
        }
    }, 1000);
}

function stopRefreshTimer() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}


function updateControlUI() {

    if (!loadedPackage || !simulationState) {
        document.getElementById("statePill").textContent = "NOT LOADED";
        document.getElementById("progressValue").textContent = "0.0%";
        document.getElementById("progressBar").style.width = "0%";
        document.getElementById("currentLocationValue").textContent = "—";
        document.getElementById("deliveryValue").textContent = "—";
        pauseButton.disabled = true;
        resumeButton.disabled = true;
        return;
    }

    const progress = getCurrentProgress(loadedPackage, simulationState);
    const paused = simulationState.paused === true;
    const delivered = progress >= 1;
    const status = paused ? "ON HOLD" : delivered ? "DELIVERED" : "RUNNING";

    const statePill = document.getElementById("statePill");
    statePill.textContent = status;
    statePill.classList.toggle("hold", paused);
    statePill.classList.toggle("done", delivered);

    document.getElementById("progressValue").textContent =
        `${(progress * 100).toFixed(1)}%`;

    document.getElementById("progressBar").style.width =
        `${progress * 100}%`;

    document.getElementById("controlTrackingNumber").textContent =
        loadedPackage.trackingNumber || loadedPackage.id;

    document.getElementById("controlSummary").textContent =
        `Current progress: ${(progress * 100).toFixed(1)}%`;

    document.getElementById("currentLocationValue").textContent =
        getCurrentLocation(loadedPackage.route, progress);

    const delivery = parseTrackFlowDate(
        simulationState.virtualDeliveryTime
    );

    document.getElementById("deliveryValue").textContent =
        paused
            ? "ON HOLD"
            : delivered
                ? "Delivered"
                : delivery
                    ? formatDate(delivery)
                    : "—";

    pauseButton.disabled = paused || delivered;
    resumeButton.disabled = !paused || delivered;

    renderAdminMap();

}


function getCurrentProgress(packageData, state) {

    if (!isValidSimulationState(state)) {

        // Do NOT silently turn a broken clock
        // into 0%.
        const departure =
            parseTrackFlowDate(
                packageData.departureTime
            );

        const delivery =
            parseTrackFlowDate(
                packageData.estimatedDeliveryTime
            );

        if (!departure || !delivery) {
            return 0;
        }

        return calculateDateProgress(
            departure,
            delivery,
            new Date()
        );
    }

    if (state.paused === true) {
        return clamp(
            Number(state.progress)
        );
    }

    const departure =
        parseTrackFlowDate(
            state.virtualDepartureTime
        );

    const delivery =
        parseTrackFlowDate(
            state.virtualDeliveryTime
        );

    return calculateDateProgress(
        departure,
        delivery,
        new Date()
    );
}


// ============================================================
// ROUTE LOCATION
// ============================================================

function getCurrentLocation(routeData, progress) {

    const route = normalizeRoute(routeData);

    if (route.length < 2) {
        return "En route…";
    }

    if (progress >= 1) {
        return route[route.length - 1].name;
    }

    const position = calculateRoutePosition(route, progress);

    if (!position) {
        return "En route…";
    }

    return `En route from ${position.segmentStart.name} → ${position.segmentEnd.name}`;
}


function normalizeRoute(routeData) {

    if (!routeData) return [];

    const points = [];

    const addPoint = (value, key, index) => {
        if (!value) return;

        if (typeof value.latitude === "number" && typeof value.longitude === "number") {
            points.push({
                name: getRouteName(value.latitude, value.longitude) || key,
                lat: value.latitude,
                lng: value.longitude,
                index
            });
            return;
        }

        if (typeof value.lat === "number" && typeof value.lng === "number") {
            points.push({
                name: value.name || getRouteName(value.lat, value.lng) || key,
                lat: value.lat,
                lng: value.lng,
                index
            });
        }
    };

    if (Array.isArray(routeData)) {
        routeData.forEach((point, index) => addPoint(point, String(index), index));
    } else if (typeof routeData === "object") {
        Object.entries(routeData).forEach(([key, value], index) => addPoint(value, key, index));
    }

    const order = {
        "Mersin, Türkiye": 0,
        "Central Transit Hub": 1,
        "European Transit Hub": 2,
        "Tönisvorst, Germany": 3
    };

    points.sort((a, b) => {
        const ao = order[a.name];
        const bo = order[b.name];
        if (ao !== undefined && bo !== undefined) return ao - bo;
        if (ao !== undefined) return -1;
        if (bo !== undefined) return 1;
        return a.index - b.index;
    });

    return points;
}


function getRouteName(lat, lng) {
    const known = [
        [36.8121, 34.6415, "Mersin, Türkiye"],
        [39.9334, 32.8597, "Central Transit Hub"],
        [41.0082, 28.9784, "European Transit Hub"],
        [51.2756, 6.3738, "Tönisvorst, Germany"]
    ];

    const match = known.find(point =>
        Math.abs(point[0] - Number(lat)) < 0.0001 &&
        Math.abs(point[1] - Number(lng)) < 0.0001
    );

    return match ? match[2] : null;
}


function calculateRoutePosition(route, progress) {

    let totalDistance = 0;
    const segments = [];

    for (let i = 0; i < route.length - 1; i++) {
        const start = route[i];
        const end = route[i + 1];
        const distance = calculateDistance(
            start.lat,
            start.lng,
            end.lat,
            end.lng
        );

        segments.push({ start, end, distance });
        totalDistance += distance;
    }

    if (totalDistance <= 0) return null;

    const target = totalDistance * clamp(progress);
    let accumulated = 0;

    for (const segment of segments) {
        const segmentEnd = accumulated + segment.distance;

        if (target <= segmentEnd) {
            const inside = target - accumulated;
            const segmentProgress = segment.distance === 0
                ? 0
                : inside / segment.distance;

            return {
                segmentStart: segment.start,
                segmentEnd: segment.end,
                lat: segment.start.lat + (segment.end.lat - segment.start.lat) * segmentProgress,
                lng: segment.start.lng + (segment.end.lng - segment.start.lng) * segmentProgress
            };
        }

        accumulated = segmentEnd;
    }

    const last = route[route.length - 1];
    return {
        segmentStart: route[route.length - 2],
        segmentEnd: last,
        lat: last.lat,
        lng: last.lng
    };
}


function calculateDistance(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) ** 2;

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadius * c;
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}


// ============================================================
// DATE HELPERS
// ============================================================

function calculateDateProgress(departure, delivery, now) {
    const start = departure.getTime();
    const end = delivery.getTime();

    if (end <= start) return 1;

    return clamp(
        (now.getTime() - start) / (end - start)
    );
}


function parseTrackFlowDate(value) {

    if (!value) return null;

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (value && typeof value.toDate === "function") {
        const date = value.toDate();
        return Number.isNaN(date.getTime()) ? null : date;
    }

    if (typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const text = String(value)
        .replace(/[—–]/g, "-")
        .replace(/\s+/g, " ")
        .trim();

    const match = text.match(
        /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i
    );

    if (match) {
        const monthDate = new Date(`${match[1]} 1, ${match[3]}`);
        if (Number.isNaN(monthDate.getTime())) return null;

        let hour = Number(match[4]);
        const minute = Number(match[5]);
        const ampm = match[6].toUpperCase();

        if (ampm === "PM" && hour !== 12) hour += 12;
        if (ampm === "AM" && hour === 12) hour = 0;

        const date = new Date(
            Number(match[3]),
            monthDate.getMonth(),
            Number(match[2]),
            hour,
            minute,
            0,
            0
        );

        return Number.isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}


function formatDate(date) {
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
    }).format(date);
}


function toFirestoreSimulation(state) {
    return {
        paused: Boolean(state.paused),
        progress: clamp(Number(state.progress)),
        virtualDepartureTime: Timestamp.fromDate(
            parseTrackFlowDate(state.virtualDepartureTime)
        ),
        virtualDeliveryTime: Timestamp.fromDate(
            parseTrackFlowDate(state.virtualDeliveryTime)
        ),
        updatedAt: Timestamp.fromDate(
            parseTrackFlowDate(state.updatedAt) || new Date()
        ),
        pausedAt: state.pausedAt
            ? Timestamp.fromDate(parseTrackFlowDate(state.pausedAt))
            : null
    };
}


function clamp(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}


// ============================================================
// UI HELPERS
// ============================================================

function setButtonsBusy(busy) {
    pauseButton.disabled = busy || pauseButton.disabled;
    resumeButton.disabled = busy || resumeButton.disabled;
    loadButton.disabled = busy;
}

function showLoginMessage(message, error) {
    loginMessage.textContent = message;
    loginMessage.style.color = error ? "#fca5a5" : "#94a3b8";
}

function showControlMessage(message, error) {
    controlMessage.textContent = message;
    controlMessage.style.color = error ? "#fca5a5" : "#94a3b8";
}

function authErrorMessage(error) {
    switch (error.code) {
        case "auth/invalid-credential":
        case "auth/wrong-password":
        case "auth/user-not-found":
            return "Incorrect email or password.";
        case "auth/too-many-requests":
            return "Too many sign-in attempts. Try again later.";
        case "auth/operation-not-allowed":
            return "Email/password sign-in is not enabled in Firebase Authentication.";
        default:
            return error.message || "Sign-in failed.";
    }
}

// ============================================================
// ADMIN MAP ENGINE
// ============================================================

function initializeAdminMap() {

    if (!adminMapElement) {
        return;
    }

    if (adminMap) {
        return;
    }

    adminMap = L.map(
        adminMapElement,
        {
            zoomControl: true,
            scrollWheelZoom: true
        }
    );

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution: "&copy; OpenStreetMap contributors"
        }
    ).addTo(adminMap);

    adminMap.on(
        "click",
        event => {

            if (!loadedPackage) {
                return;
            }

            const progress =
                calculateProgressFromMapPoint(
                    event.latlng.lat,
                    event.latlng.lng
                );

            if (progress === null) {
                showControlMessage(
                    "The selected point is outside the shipment route.",
                    true
                );
                return;
            }

            setShipmentProgressFromMap(
                progress
            );
        }
    );
}


// ============================================================
// RENDER ADMIN MAP
// ============================================================

function renderAdminMap() {

    if (
        !adminMap ||
        !loadedPackage ||
        !simulationState
    ) {
        return;
    }

    if (adminMapDragging) {
        return;
    }

    adminRoute =
        normalizeRoute(
            loadedPackage.route
        );

    if (adminRoute.length < 2) {
        return;
    }

    const progress =
        getCurrentProgress(
            loadedPackage,
            simulationState
        );

    const position =
        calculateRoutePosition(
            adminRoute,
            progress
        );

    if (!position) {
        return;
    }

    // --------------------------------------------------------
    // ROUTE LINE
    // --------------------------------------------------------

    const routeLatLngs =
        adminRoute.map(
            point => [
                point.lat,
                point.lng
            ]
        );

    if (!adminRouteLine) {

        adminRouteLine =
            L.polyline(
                routeLatLngs,
                {
                    weight: 4,
                    opacity: 0.75,
                    dashArray: "10 8"
                }
            ).addTo(adminMap);

    } else {

        adminRouteLine.setLatLngs(
            routeLatLngs
        );
    }


    // --------------------------------------------------------
    // SHIPMENT MARKER
    // --------------------------------------------------------

    if (!adminShipmentMarker) {

        const markerIcon =
            L.divIcon({
                className: "",
                html: '<div class="admin-map-marker"></div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });

        adminShipmentMarker =
            L.marker(
                [
                    position.lat,
                    position.lng
                ],
                {
                    icon: markerIcon,
                    draggable: true
                }
            ).addTo(adminMap);

        adminShipmentMarker.bindPopup(
            "Drag this marker to change shipment location."
        );

        adminShipmentMarker.on(
            "dragstart",
            () => {

                adminMapDragging = true;

                if (mapControlMode) {
                    mapControlMode.textContent =
                        "MANUAL CONTROL";
                }
            }
        );

        adminShipmentMarker.on(
            "drag",
            event => {

                const point =
                    event.target.getLatLng();

                const progress =
                    calculateProgressFromMapPoint(
                        point.lat,
                        point.lng
                    );

                if (
                    progress === null
                ) {
                    return;
                }

                updateAdminMapPreview(
                    progress
                );
            }
        );

        adminShipmentMarker.on(
            "dragend",
            async event => {

                const point =
                    event.target.getLatLng();

                const progress =
                    calculateProgressFromMapPoint(
                        point.lat,
                        point.lng
                    );

                adminMapDragging = false;

                if (progress === null) {

                    renderAdminMap();

                    showControlMessage(
                        "The marker must remain on the shipment route.",
                        true
                    );

                    return;
                }

                await setShipmentProgressFromMap(
                    progress
                );
            }
        );

    } else {

        adminShipmentMarker.setLatLng(
            [
                position.lat,
                position.lng
            ]
        );
    }


    // --------------------------------------------------------
    // MAP VIEW
    // --------------------------------------------------------

    if (
        !adminMap._trackFlowInitialised
    ) {

        adminMap.fitBounds(
            adminRouteLine.getBounds(),
            {
                padding: [35, 35]
            }
        );

        adminMap._trackFlowInitialised =
            true;
    }


    updateAdminMapPreview(
        progress
    );
}


// ============================================================
// MAP PREVIEW
// ============================================================

function updateAdminMapPreview(
    progress
) {

    if (!loadedPackage) {
        return;
    }

    const route =
        normalizeRoute(
            loadedPackage.route
        );

    const position =
        calculateRoutePosition(
            route,
            progress
        );

    if (!position) {
        return;
    }

    const location =
        progress >= 1
            ? position.segmentEnd.name
            : `En route from ${position.segmentStart.name} → ${position.segmentEnd.name}`;

    if (mapProgressValue) {

        mapProgressValue.textContent =
            `${(progress * 100).toFixed(1)}%`;
    }

    if (mapLocationValue) {

        mapLocationValue.textContent =
            location;
    }

    if (mapControlMode) {

        mapControlMode.textContent =
            adminMapDragging
                ? "MANUAL CONTROL"
                : simulationState?.paused
                    ? "PAUSED"
                    : "LIVE";
    }

    if (
        adminShipmentMarker &&
        !adminMapDragging
    ) {

        adminShipmentMarker.setLatLng(
            [
                position.lat,
                position.lng
            ]
        );
    }
}


// ============================================================
// CONVERT MAP LOCATION → ROUTE PROGRESS
// ============================================================

function calculateProgressFromMapPoint(
    lat,
    lng
) {

    if (
        !Array.isArray(adminRoute) ||
        adminRoute.length < 2
    ) {
        return null;
    }

    let totalDistance = 0;

    const segments = [];

    for (
        let i = 0;
        i < adminRoute.length - 1;
        i++
    ) {

        const start =
            adminRoute[i];

        const end =
            adminRoute[i + 1];

        const distance =
            calculateDistance(
                start.lat,
                start.lng,
                end.lat,
                end.lng
            );

        segments.push({
            start,
            end,
            distance
        });

        totalDistance +=
            distance;
    }

    if (
        totalDistance <= 0
    ) {
        return null;
    }


    let bestDistance =
        Infinity;

    let bestProgress =
        0;

    let accumulatedDistance =
        0;


    for (
        const segment of segments
    ) {

        const midLat =
            (
                segment.start.lat +
                segment.end.lat
            ) / 2;

        const cosLat =
            Math.cos(
                toRadians(midLat)
            );


        const startX =
            segment.start.lng *
            cosLat;

        const startY =
            segment.start.lat;

        const endX =
            segment.end.lng *
            cosLat;

        const endY =
            segment.end.lat;

        const pointX =
            lng *
            cosLat;

        const pointY =
            lat;


        const dx =
            endX -
            startX;

        const dy =
            endY -
            startY;


        const lengthSquared =
            dx * dx +
            dy * dy;


        let t = 0;

        if (
            lengthSquared > 0
        ) {

            t =
                (
                    (pointX - startX) * dx +
                    (pointY - startY) * dy
                ) /
                lengthSquared;
        }


        t =
            Math.max(
                0,
                Math.min(
                    1,
                    t
                )
            );


        const closestX =
            startX +
            dx * t;

        const closestY =
            startY +
            dy * t;


        const distanceToRoute =
            Math.sqrt(
                (
                    pointX -
                    closestX
                ) ** 2 +
                (
                    pointY -
                    closestY
                ) ** 2
            );


        if (
            distanceToRoute <
            bestDistance
        ) {

            bestDistance =
                distanceToRoute;


            const distanceAlongSegment =
                segment.distance *
                t;


            bestProgress =
                (
                    accumulatedDistance +
                    distanceAlongSegment
                ) /
                totalDistance;
        }


        accumulatedDistance +=
            segment.distance;
    }


    return clamp(
        bestProgress
    );
}


// ============================================================
// SAVE MANUAL MAP POSITION
// ============================================================

async function setShipmentProgressFromMap(
    progress
) {

    if (
        !loadedPackage ||
        !simulationState
    ) {
        return;
    }

    progress =
        clamp(
            Number(progress)
        );


    try {

        setButtonsBusy(
            true
        );

        const packageRef =
            doc(
                db,
                "packages",
                loadedPackage.id
            );


        const freshSnapshot =
            await getDoc(
                packageRef
            );


        if (
            !freshSnapshot.exists()
        ) {
            throw new Error(
                "Shipment no longer exists."
            );
        }


        const freshPackage =
            freshSnapshot.data();

let freshState =
    freshPackage.simulation;

if (
    !isValidSimulationState(
        freshState
    )
) {

    freshState =
        createInitialSimulationState(
            freshPackage
        );

    await updateDoc(
        packageRef,
        {
            simulation:
                toFirestoreSimulation(
                    freshState
                )
        }
    );
}


        const now =
            new Date();


        const paused =
            freshState.paused === true;


        const oldDeparture =
            parseTrackFlowDate(
                freshState.virtualDepartureTime
            );

        const oldDelivery =
            parseTrackFlowDate(
                freshState.virtualDeliveryTime
            );


        if (
            !oldDeparture ||
            !oldDelivery ||
            oldDelivery <= oldDeparture
        ) {

            throw new Error(
                "Simulation clock is invalid."
            );
        }


        const duration =
            oldDelivery.getTime() -
            oldDeparture.getTime();


        let newDeparture;
        let newDelivery;


        if (paused) {

            // While paused, keep the existing
            // virtual schedule frozen.

            newDeparture =
                oldDeparture;

            newDelivery =
                oldDelivery;

        } else {

            // While running, move the virtual
            // clock so the selected map position
            // becomes the exact current position.

            newDeparture =
                new Date(
                    now.getTime() -
                    duration * progress
                );

            newDelivery =
                new Date(
                    now.getTime() +
                    duration *
                    (1 - progress)
                );
        }


        await updateDoc(
            packageRef,
            {
                simulation: {
                    paused,
                    progress,
                    virtualDepartureTime:
                        Timestamp.fromDate(
                            newDeparture
                        ),
                    virtualDeliveryTime:
                        Timestamp.fromDate(
                            newDelivery
                        ),
                    updatedAt:
                        Timestamp.fromDate(
                            now
                        ),
                    pausedAt:
                        paused
                            ? (
                                freshState.pausedAt
                                    ? Timestamp.fromDate(
                                        parseTrackFlowDate(
                                            freshState.pausedAt
                                        )
                                    )
                                    : Timestamp.fromDate(
                                        now
                                    )
                            )
                            : null
                }
            }
        );


        simulationState = {
            paused,
            progress,
            virtualDepartureTime:
                newDeparture,
            virtualDeliveryTime:
                newDelivery,
            updatedAt:
                now,
            pausedAt:
                paused
                    ? parseTrackFlowDate(
                        freshState.pausedAt
                    ) || now
                    : null
        };


        loadedPackage = {
            id:
                freshSnapshot.id,
            ...freshPackage,
            simulation:
                simulationState
        };


        updateControlUI();

        showControlMessage(
            `Shipment position changed to ${(progress * 100).toFixed(1)}%. Public tracking has been synchronized.`,
            false
        );


    } catch (error) {

        console.error(
            error
        );

        showControlMessage(
            error.code === "permission-denied"
                ? "Location change denied by Firestore rules."
                : error.message ||
                  "Unable to change shipment location.",
            true
        );

        renderAdminMap();

    } finally {

        setButtonsBusy(
            false
        );
    }
}
