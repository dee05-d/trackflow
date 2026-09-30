import {
    initializeApp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import {
    getFirestore,
    doc,
    getDoc,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";


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


// ============================================================
// GLOBAL STATE
// ============================================================

let currentPackage = null;

let simulationTimer = null;
let simulationUnsubscribe = null;
let simulationState = null;

let trackingMap = null;
let routeLine = null;
let shipmentMarker = null;
let destinationMarker = null;


// ============================================================
// TRACK PACKAGE
// ============================================================

window.trackPackage = async function () {

    const input =
        document.getElementById("trackingInput");

    if (!input) {
        console.error("trackingInput was not found.");
        return;
    }

    const trackingNumber =
        input.value.trim().toUpperCase();

    if (!trackingNumber) {
        alert("Please enter a tracking number.");
        return;
    }

    try {

        const packageRef =
            doc(
                db,
                "packages",
                trackingNumber
            );

        const snapshot =
            await getDoc(packageRef);

        if (!snapshot.exists()) {

            alert(
                "Tracking number not found."
            );

            return;
        }

        currentPackage = {
            id: snapshot.id,
            ...snapshot.data()
        };

        console.log(
            "TrackFlow package loaded:",
            currentPackage
        );

        displayPackage(
            currentPackage
        );

    } catch (error) {

        console.error(
            "Firebase tracking error:",
            error
        );

        alert(
            "Unable to load the tracking information."
        );
    }
};


// ============================================================
// DISPLAY PACKAGE
// ============================================================

function displayPackage(packageData) {

    const resultContainer =
        document.getElementById(
            "trackingResult"
        );

    if (!resultContainer) {

        console.error(
            "trackingResult was not found."
        );

        return;
    }

    resultContainer.classList.remove("hidden");
    resultContainer.style.display = "block";


    // --------------------------------------------------------
    // BASIC INFORMATION
    // --------------------------------------------------------

    setText(
        "trackingNumber",
        packageData.trackingNumber ||
        packageData.id ||
        "—"
    );

    setText(
        "senderName",
        packageData.senderName ||
        "—"
    );

    setText(
        "recipientName",
        packageData.recipientName ||
        "—"
    );

    setText(
        "deliveryAddress",
        packageData.deliveryAddress ||
        "—"
    );

    setText(
        "currentLocation",
        packageData.currentLocation ||
        packageData.origin ||
        "—"
    );

    // IMPORTANT:
    // Firestore uses estimatedDeliveryTime
    setText(
        "estimatedDelivery",
        packageData.estimatedDeliveryTime ||
        "—"
    );

    setText(
        "service",
        packageData.service ||
        "—"
    );

    setText(
        "packageType",
        packageData.packageType ||
        "—"
    );

    setText(
        "contactDetail",
        packageData.contactDetail ||
        "—"
    );


    // --------------------------------------------------------
    // ROUTE
    // --------------------------------------------------------

    const route =
        normalizeRoute(
            packageData.route
        );

    if (route.length >= 2) {

        setText(
            "routeFrom",
            route[0].name
        );

        setText(
            "routeTo",
            route[route.length - 1].name
        );
    }


    // --------------------------------------------------------
    // START DATE-DRIVEN TRACKING
    // --------------------------------------------------------

    startPackageSimulation(
        packageData
    );
}


// ============================================================
// FIRESTORE ROUTE CONVERTER
// ============================================================

function normalizeRoute(routeData) {

    if (!routeData) {

        console.error(
            "Route data is empty."
        );

        return [];
    }


    // --------------------------------------------------------
    // ARRAY
    // --------------------------------------------------------

    if (Array.isArray(routeData)) {

        return routeData
            .map((item, index) => {

                return extractRoutePoint(
                    item,
                    String(index)
                );

            })
            .filter(Boolean);
    }


    // --------------------------------------------------------
    // FIRESTORE MAP / OBJECT
    // --------------------------------------------------------

    if (
        typeof routeData === "object"
    ) {

        const entries =
            Object.entries(routeData);

        const points =
            entries
                .map(([key, value]) => {

                    return extractRoutePoint(
                        value,
                        key
                    );

                })
                .filter(Boolean);


        // ----------------------------------------------------
        // SORT KNOWN ROUTE
        // ----------------------------------------------------

        points.sort(
            (a, b) => {

                const order = {

                    "Mersin, Türkiye": 0,

                    "Central Transit Hub": 1,

                    "European Transit Hub": 2,

                    "Tönisvorst, Germany": 3
                };

                const aOrder =
                    order[a.name];

                const bOrder =
                    order[b.name];


                if (
                    aOrder !== undefined &&
                    bOrder !== undefined
                ) {

                    return aOrder - bOrder;
                }


                if (
                    aOrder !== undefined
                ) {

                    return -1;
                }


                if (
                    bOrder !== undefined
                ) {

                    return 1;
                }


                return (
                    a.originalIndex -
                    b.originalIndex
                );
            }
        );


        // ----------------------------------------------------
        // FALLBACK NAMES
        // ----------------------------------------------------

        const fallbackNames = {

            "36.8121,34.6415":
                "Mersin, Türkiye",

            "39.9334,32.8597":
                "Central Transit Hub",

            "41.0082,28.9784":
                "European Transit Hub",

            "51.2756,6.3738":
                "Tönisvorst, Germany"
        };


        return points.map(
            point => {

                if (
                    !point.name ||
                    /^(\d+|point|route)$/i.test(
                        point.name
                    )
                ) {

                    const coordinateKey =
                        `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;

                    point.name =
                        fallbackNames[
                            coordinateKey
                        ] ||
                        point.name ||
                        "Transit Point";
                }

                return point;
            }
        );
    }


    console.error(
        "Unsupported Firestore route structure:",
        routeData
    );

    return [];
}


// ============================================================
// EXTRACT ROUTE POINT
// ============================================================

function extractRoutePoint(
    value,
    key
) {

    if (!value) {
        return null;
    }


    // --------------------------------------------------------
    // FIRESTORE GEOPOINT
    // --------------------------------------------------------

    if (
        typeof value.latitude === "number" &&
        typeof value.longitude === "number"
    ) {

        return {

            name:
                getRouteNameFromCoordinates(
                    value.latitude,
                    value.longitude
                ) ||
                key,

            lat:
                value.latitude,

            lng:
                value.longitude,

            originalIndex:
                Number.isFinite(
                    Number(key)
                )
                    ? Number(key)
                    : 999
        };
    }


    // --------------------------------------------------------
    // LAT / LNG
    // --------------------------------------------------------

    if (
        typeof value.lat === "number" &&
        typeof value.lng === "number"
    ) {

        return {

            name:
                value.name ||
                getRouteNameFromCoordinates(
                    value.lat,
                    value.lng
                ) ||
                key,

            lat:
                value.lat,

            lng:
                value.lng,

            originalIndex:
                Number.isFinite(
                    Number(key)
                )
                    ? Number(key)
                    : 999
        };
    }


    // --------------------------------------------------------
    // LATITUDE / LONGITUDE
    // --------------------------------------------------------

    if (
        typeof value.latitude === "number" &&
        typeof value.longitude === "number"
    ) {

        return {

            name:
                value.name ||
                getRouteNameFromCoordinates(
                    value.latitude,
                    value.longitude
                ) ||
                key,

            lat:
                value.latitude,

            lng:
                value.longitude,

            originalIndex:
                Number.isFinite(
                    Number(key)
                )
                    ? Number(key)
                    : 999
        };
    }


    // --------------------------------------------------------
    // NESTED OBJECT
    // --------------------------------------------------------

    if (
        typeof value === "object"
    ) {

        const possibleName =
            value.name ||
            value.title ||
            (
                typeof key === "string"
                    ? key
                    : ""
            );


        const possibleGeoPoint =
            value.location ||
            value.coordinates ||
            value.position ||
            value.geoPoint ||
            value.geopoint;


        if (
            possibleGeoPoint &&
            typeof possibleGeoPoint.latitude ===
                "number" &&
            typeof possibleGeoPoint.longitude ===
                "number"
        ) {

            return {

                name:
                    possibleName ||
                    getRouteNameFromCoordinates(
                        possibleGeoPoint.latitude,
                        possibleGeoPoint.longitude
                    ) ||
                    "Transit Point",

                lat:
                    possibleGeoPoint.latitude,

                lng:
                    possibleGeoPoint.longitude,

                originalIndex:
                    Number.isFinite(
                        Number(key)
                    )
                        ? Number(key)
                        : 999
            };
        }


        // ----------------------------------------------------
        // NESTED LAT / LNG
        // ----------------------------------------------------

        if (
            Number.isFinite(
                Number(value.lat)
            ) &&
            Number.isFinite(
                Number(value.lng)
            )
        ) {

            return {

                name:
                    possibleName ||
                    getRouteNameFromCoordinates(
                        Number(value.lat),
                        Number(value.lng)
                    ) ||
                    "Transit Point",

                lat:
                    Number(value.lat),

                lng:
                    Number(value.lng),

                originalIndex:
                    Number.isFinite(
                        Number(key)
                    )
                        ? Number(key)
                        : 999
            };
        }
    }


    return null;
}


// ============================================================
// IDENTIFY ROUTE NAME
// ============================================================

function getRouteNameFromCoordinates(
    lat,
    lng
) {

    const knownPoints = [

        {
            name: "Mersin, Türkiye",
            lat: 36.8121,
            lng: 34.6415
        },

        {
            name: "Central Transit Hub",
            lat: 39.9334,
            lng: 32.8597
        },

        {
            name: "European Transit Hub",
            lat: 41.0082,
            lng: 28.9784
        },

        {
            name: "Tönisvorst, Germany",
            lat: 51.2756,
            lng: 6.3738
        }
    ];


    const match =
        knownPoints.find(
            point => {

                return (
                    Math.abs(
                        point.lat -
                        Number(lat)
                    ) < 0.0001
                    &&
                    Math.abs(
                        point.lng -
                        Number(lng)
                    ) < 0.0001
                );
            }
        );


    return match
        ? match.name
        : null;
}


// ============================================================
// DATE-DRIVEN TRACKING ENGINE
// ============================================================

function startPackageSimulation(packageData) {

    if (simulationTimer) {
        clearInterval(simulationTimer);
        simulationTimer = null;
    }

    if (simulationUnsubscribe) {
        simulationUnsubscribe();
        simulationUnsubscribe = null;
    }

    const route = normalizeRoute(packageData.route);
    const packageRef = doc(db, "packages", packageData.id);

    if (!Array.isArray(route) || route.length < 2) {
        console.error("Tracking route is missing or invalid.");
        return;
    }

    initializeTrackingMap(route);

    simulationUnsubscribe = onSnapshot(
        packageRef,
        snapshot => {

            if (!snapshot.exists()) {
                console.error("Tracking package no longer exists.");
                return;
            }

            const freshPackage = {
                id: snapshot.id,
                ...snapshot.data()
            };

            currentPackage = freshPackage;
            simulationState = freshPackage.simulation || null;

            renderCurrentSimulation(
                freshPackage,
                route
            );

            if (simulationTimer) {
                clearInterval(simulationTimer);
                simulationTimer = null;
            }

            simulationTimer = setInterval(
                () => {
                    renderCurrentSimulation(
                        currentPackage || freshPackage,
                        route
                    );
                },
                1000
            );
        },
        error => {
            console.error("TrackFlow live state error:", error);
        }
    );
}


// ============================================================
// RENDER CURRENT SIMULATION STATE
// ============================================================

function renderCurrentSimulation(
    packageData,
    route
) {

    const originalDeparture = parseTrackFlowDate(
        packageData.departureTime
    );

    const originalDelivery = parseTrackFlowDate(
        packageData.estimatedDeliveryTime
    );

    if (!originalDeparture || !originalDelivery) {
        console.error("Tracking dates are invalid.");
        return;
    }

    const state = packageData.simulation || simulationState;
    const now = new Date();

    let progress;
    let virtualDeparture;
    let virtualDelivery;
    let virtualNow;
    let paused = false;

    if (
        state &&
        typeof state.progress === "number" &&
        state.virtualDepartureTime &&
        state.virtualDeliveryTime
    ) {
        paused = state.paused === true;

        virtualDeparture = parseTrackFlowDate(
            state.virtualDepartureTime
        );

        virtualDelivery = parseTrackFlowDate(
            state.virtualDeliveryTime
        );

        if (!virtualDeparture || !virtualDelivery) {
            progress = calculateDateProgress(
                originalDeparture,
                originalDelivery,
                now
            );
            virtualDeparture = originalDeparture;
            virtualDelivery = originalDelivery;
        } else if (paused) {
            progress = Math.max(
                0,
                Math.min(1, Number(state.progress))
            );
        } else {
            progress = calculateDateProgress(
                virtualDeparture,
                virtualDelivery,
                now
            );
        }
    } else {
        progress = calculateDateProgress(
            originalDeparture,
            originalDelivery,
            now
        );
        virtualDeparture = originalDeparture;
        virtualDelivery = originalDelivery;
    }

    if (paused) {
        virtualNow = new Date(
            virtualDeparture.getTime() +
            (
                virtualDelivery.getTime() -
                virtualDeparture.getTime()
            ) * progress
        );
    } else {
        virtualNow = now;
    }

    const position = calculateRoutePosition(
        route,
        progress
    );

    if (!position) {
        console.error("Unable to calculate shipment position.");
        return;
    }

    updateCurrentLocation(position, progress);
    updateMapMarker(position);

    const status = paused
        ? "ON HOLD"
        : calculateStatus(progress);

    updateStatus(status);

    updateETA(
        now,
        virtualDelivery,
        progress,
        paused
    );

    updateAutomaticTimeline(
        progress,
        virtualDeparture,
        virtualDelivery,
        packageData,
        virtualNow,
        paused
    );

    const movementState = document.getElementById("movementState");

    if (movementState) {
        movementState.textContent = paused
            ? "ON HOLD"
            : progress >= 1
                ? "DELIVERED"
                : "MOVING";
    }

    const routeLive = document.querySelector(".route-live");

    if (routeLive) {
        routeLive.innerHTML = paused
            ? '<span class="hold-dot"></span> ON HOLD'
            : '<span class="live-dot"></span> LIVE';
    }

    console.log(
        `TrackFlow progress: ${(progress * 100).toFixed(2)}%`,
        {
            progress,
            paused,
            position,
            status,
            virtualDelivery
        }
    );
}


// ============================================================
// CALCULATE CALENDAR PROGRESS
// ============================================================

function calculateDateProgress(
    departure,
    delivery,
    now
) {

    const start = departure.getTime();
    const end = delivery.getTime();
    const current = now.getTime();

    if (end <= start) {
        return 1;
    }

    const progress =
        (current - start) /
        (end - start);

    return Math.max(
        0,
        Math.min(1, progress)
    );
}


// ============================================================
// CURRENT LOCATION
// ============================================================

function updateCurrentLocation(
    position,
    progress
) {

    const locationElement =
        document.getElementById(
            "currentLocation"
        );

    if (!locationElement) {
        return;
    }


    let locationName =
        position.name ||
        "En route";


    if (
        progress <= 0
    ) {

        locationName =
            position.segmentStart?.name ||
            position.name ||
            "Origin";
    }


    if (
        progress > 0 &&
        progress < 1 &&
        position.segmentStart &&
        position.segmentEnd
    ) {

        locationName =
            `En route from ${position.segmentStart.name} → ${position.segmentEnd.name}`;
    }


    if (
        progress >= 1
    ) {

        locationName =
            position.segmentEnd?.name ||
            position.name ||
            "Destination";
    }


    locationElement.textContent =
        locationName;
}


// ============================================================
// STATUS ENGINE
// ============================================================

function calculateStatus(
    progress
) {

    if (progress <= 0) {
        return "PROCESSING";
    }

    if (progress < 0.08) {
        return "DEPARTED";
    }

    if (progress < 0.70) {
        return "IN TRANSIT";
    }

    if (progress < 0.90) {
        return "ARRIVED AT HUB";
    }

    if (progress < 1) {
        return "OUT FOR DELIVERY";
    }

    return "DELIVERED";
}


// ============================================================
// UPDATE STATUS
// ============================================================

function updateStatus(
    status
) {

    const statusElement =
        document.getElementById(
            "statusText"
        );

    if (statusElement) {

        statusElement.textContent =
            status;
    }


    const badge =
        document.getElementById(
            "statusBadge"
        );

    if (!badge) {
        return;
    }


    badge.classList.remove(
        "departing",
        "departed",
        "in-transit",
        "arrived",
        "out-for-delivery",
        "delivered",
        "on-hold"
    );


    switch (status) {

        case "ON HOLD":

            badge.classList.add(
                "on-hold"
            );

            break;


        case "PROCESSING":

            badge.classList.add(
                "departing"
            );

            break;


        case "DEPARTED":

            badge.classList.add(
                "departed"
            );

            break;


        case "IN TRANSIT":

            badge.classList.add(
                "in-transit"
            );

            break;


        case "ARRIVED AT HUB":

            badge.classList.add(
                "arrived"
            );

            break;


        case "OUT FOR DELIVERY":

            badge.classList.add(
                "out-for-delivery"
            );

            break;


        case "DELIVERED":

            badge.classList.add(
                "delivered"
            );

            break;
    }
}


// ============================================================
// ETA
// ============================================================

function updateETA(
    now,
    delivery,
    progress,
    paused = false
) {

    const element =
        document.getElementById(
            "estimatedDelivery"
        );

    if (!element) {
        return;
    }


    if (paused) {

        element.textContent =
            "ON HOLD";

        return;
    }


    if (
        progress >= 1
    ) {

        element.textContent =
            "Delivered";

        return;
    }


    const remaining =
        Math.max(
            0,
            delivery.getTime() -
            now.getTime()
        );


    const totalSeconds =
        Math.floor(
            remaining / 1000
        );


    const days =
        Math.floor(
            totalSeconds / 86400
        );


    const hours =
        Math.floor(
            (
                totalSeconds % 86400
            ) / 3600
        );


    const minutes =
        Math.floor(
            (
                totalSeconds % 3600
            ) / 60
        );


    const seconds =
        totalSeconds % 60;


    element.textContent =
        `${days}d ${hours}h ${minutes}m ${seconds}s`;
}


// ============================================================
// SHIPMENT HISTORY
// ============================================================

function updateAutomaticTimeline(
    progress,
    departure,
    delivery,
    packageData,
    trackingNow = new Date(),
    paused = false
) {

    const timeline =
        document.getElementById(
            "shipmentTimeline"
        );

    if (!timeline) {

        console.warn(
            "Element #shipmentTimeline was not found."
        );

        return;
    }


    if (
        !departure ||
        !delivery
    ) {

        timeline.innerHTML = "";

        return;
    }


    // --------------------------------------------------------
    // EVENT DEFINITIONS
    //
    // The threshold determines where in the journey
    // the event is scheduled.
    // --------------------------------------------------------

    const events = [

        {
            threshold: 0,

            title:
                "Package Accepted",

            description:
                "Shipment information received"
        },

        {
            threshold: 0.08,

            title:
                "Departed Origin Facility",

            description:
                "Package departed from Mersin, Türkiye"
        },

        {
            threshold: 0.15,

            title:
                "In Transit",

            description:
                "Shipment is moving through the transit network"
        },

        {
            threshold: 0.70,

            title:
                "Arrived at Distribution Hub",

            description:
                "Package reached the European transit network"
        },

        {
            threshold: 0.90,

            title:
                "Out for Delivery",

            description:
                "Shipment is on the final delivery route"
        },

        {
            threshold: 1,

            title:
                "Delivered",

            description:
                "Package has reached its destination"
        }
    ];


    timeline.innerHTML = "";


    const now = trackingNow;


    events.forEach(
        (event, index) => {

            const eventTime =
                new Date(
                    departure.getTime() +
                    (
                        delivery.getTime() -
                        departure.getTime()
                    ) *
                    event.threshold
                );


            const isCompleted =
                now.getTime() >=
                eventTime.getTime();


            const nextEvent =
                events[index + 1];


            const nextEventTime =
                nextEvent
                    ? new Date(
                        departure.getTime() +
                        (
                            delivery.getTime() -
                            departure.getTime()
                        ) *
                        nextEvent.threshold
                    )
                    : null;


            const isCurrent =
                !isCompleted &&
                (
                    index === 0 ||
                    now.getTime() >=
                    (
                        new Date(
                            departure.getTime() +
                            (
                                delivery.getTime() -
                                departure.getTime()
                            ) *
                            events[index - 1].threshold
                        )
                    ).getTime()
                ) &&
                (
                    !nextEventTime ||
                    now.getTime() <
                    nextEventTime.getTime()
                );


            const item =
                document.createElement(
                    "div"
                );


            let stateClass =
                "timeline-item upcoming";


            if (isCompleted) {

                stateClass =
                    "timeline-item completed";

            } else if (isCurrent) {

                stateClass =
                    paused
                        ? "timeline-item active on-hold"
                        : "timeline-item active";
            }


            item.className =
                stateClass;


            const marker =
                isCompleted
                    ? "✓"
                    : isCurrent
                        ? ""
                        : "○";


            const stateLabel =
                isCompleted
                    ? "COMPLETED"
                    : isCurrent
                        ? paused
                            ? "ON HOLD"
                            : "CURRENT"
                        : "SCHEDULED";


            item.innerHTML = `

                <div class="timeline-marker">
                    ${
                        isCurrent
                            ? '<span class="live-dot"></span>'
                            : `<span>${marker}</span>`
                    }
                </div>

                <div class="timeline-content">

                    <div class="timeline-title">
                        ${escapeHTML(event.title)}
                    </div>

                    <div class="timeline-description">
                        ${escapeHTML(event.description)}
                    </div>

                    <div class="timeline-date">
                        ${formatTrackFlowDate(eventTime)}
                    </div>

                    <div class="timeline-state">
                        ${stateLabel}
                    </div>

                </div>
            `;


            timeline.appendChild(
                item
            );
        }
    );
}


// ============================================================
// ROUTE POSITION
// ============================================================

function calculateRoutePosition(
    route,
    progress
) {

    if (
        !Array.isArray(route) ||
        route.length < 2
    ) {

        return null;
    }


    let totalDistance = 0;

    const segments = [];


    for (
        let i = 0;
        i < route.length - 1;
        i++
    ) {

        const start =
            route[i];

        const end =
            route[i + 1];


        const distance =
            calculateDistance(
                Number(start.lat),
                Number(start.lng),
                Number(end.lat),
                Number(end.lng)
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


    const targetDistance =
        totalDistance *
        progress;


    let accumulated = 0;


    for (
        const segment of segments
    ) {

        const segmentEnd =
            accumulated +
            segment.distance;


        if (
            targetDistance <=
            segmentEnd
        ) {

            const distanceInside =
                targetDistance -
                accumulated;


            const segmentProgress =
                segment.distance === 0
                    ? 0
                    : distanceInside /
                      segment.distance;


            const lat =
                Number(
                    segment.start.lat
                ) +
                (
                    Number(
                        segment.end.lat
                    ) -
                    Number(
                        segment.start.lat
                    )
                ) *
                segmentProgress;


            const lng =
                Number(
                    segment.start.lng
                ) +
                (
                    Number(
                        segment.end.lng
                    ) -
                    Number(
                        segment.start.lng
                    )
                ) *
                segmentProgress;


            return {

                name:
                    segment.start.name,

                lat,

                lng,

                segmentStart:
                    segment.start,

                segmentEnd:
                    segment.end,

                segmentProgress
            };
        }


        accumulated =
            segmentEnd;
    }


    const last =
        route[
            route.length - 1
        ];


    return {

        name:
            last.name,

        lat:
            Number(last.lat),

        lng:
            Number(last.lng),

        segmentStart:
            route[
                route.length - 2
            ],

        segmentEnd:
            last,

        segmentProgress: 1
    };
}


// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function calculateDistance(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const earthRadius =
        6371;


    const dLat =
        toRadians(
            lat2 - lat1
        );


    const dLon =
        toRadians(
            lon2 - lon1
        );


    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(
            toRadians(lat1)
        ) *
        Math.cos(
            toRadians(lat2)
        ) *
        Math.sin(dLon / 2) ** 2;


    const c =
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );


    return (
        earthRadius *
        c
    );
}


function toRadians(
    degrees
) {

    return (
        degrees *
        Math.PI /
        180
    );
}


// ============================================================
// LEAFLET MAP
// ============================================================

function initializeTrackingMap(
    route
) {

    if (
        typeof L === "undefined"
    ) {

        console.error(
            "Leaflet has not loaded. Check the Leaflet script tag."
        );

        return;
    }


    if (
        !Array.isArray(route) ||
        route.length < 2
    ) {

        console.error(
            "Map cannot initialize because the route is invalid.",
            route
        );

        return;
    }


    const mapElement =
        document.getElementById(
            "trackingMap"
        );


    if (!mapElement) {

        console.error(
            "#trackingMap was not found in the HTML."
        );

        return;
    }


    // --------------------------------------------------------
    // CREATE MAP ONCE
    // --------------------------------------------------------

    if (!trackingMap) {

        trackingMap =
            L.map(
                mapElement,
                {
                    zoomControl: true,
                    attributionControl: true
                }
            );


        L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
                maxZoom: 19,

                attribution:
                    "&copy; OpenStreetMap contributors"
            }
        ).addTo(
            trackingMap
        );
    }


    // --------------------------------------------------------
    // ROUTE COORDINATES
    // --------------------------------------------------------

    const coordinates =
        route.map(
            point => [

                Number(point.lat),

                Number(point.lng)

            ]
        );


    // --------------------------------------------------------
    // ROUTE LINE
    // --------------------------------------------------------

    if (routeLine) {

        trackingMap.removeLayer(
            routeLine
        );
    }


    routeLine =
        L.polyline(
            coordinates,
            {
                className:
                    "track-route-line",

                weight:
                    5,

                opacity:
                    0.9,

                smoothFactor:
                    1
            }
        ).addTo(
            trackingMap
        );


    // --------------------------------------------------------
    // DESTINATION MARKER
    // --------------------------------------------------------

    const destination =
        route[
            route.length - 1
        ];


    if (destinationMarker) {

        trackingMap.removeLayer(
            destinationMarker
        );
    }


    const destinationIcon =
        L.divIcon({

            className: "",

            html:
                `<div class="destination-marker"></div>`,

            iconSize:
                [20, 20],

            iconAnchor:
                [10, 10]
        });


    destinationMarker =
        L.marker(
            [
                Number(
                    destination.lat
                ),

                Number(
                    destination.lng
                )
            ],
            {
                icon:
                    destinationIcon
            }
        )
        .addTo(
            trackingMap
        )
        .bindTooltip(
            destination.name ||
            "Destination"
        );


    // --------------------------------------------------------
    // SHIPMENT MARKER
    // --------------------------------------------------------

    if (shipmentMarker) {

        trackingMap.removeLayer(
            shipmentMarker
        );
    }


    const shipmentIcon =
        L.divIcon({

            className: "",

            html:
                `<div class="shipment-marker">📦</div>`,

            iconSize:
                [46, 46],

            iconAnchor:
                [23, 23]
        });


    const start =
        route[0];


    shipmentMarker =
        L.marker(
            [
                Number(start.lat),

                Number(start.lng)
            ],
            {
                icon:
                    shipmentIcon,

                zIndexOffset:
                    1000
            }
        )
        .addTo(
            trackingMap
        );


    // --------------------------------------------------------
    // FIT MAP
    // --------------------------------------------------------

    trackingMap.fitBounds(
        routeLine.getBounds(),
        {
            padding:
                [50, 50]
        }
    );


    setTimeout(
        () => {

            if (trackingMap) {

                trackingMap.invalidateSize();

                trackingMap.fitBounds(
                    routeLine.getBounds(),
                    {
                        padding:
                            [50, 50]
                    }
                );
            }

        },
        500
    );
}


// ============================================================
// MOVE SHIPMENT MARKER
// ============================================================

function updateMapMarker(
    position
) {

    if (
        !shipmentMarker ||
        !trackingMap
    ) {

        return;
    }


    shipmentMarker.setLatLng(
        [
            Number(position.lat),

            Number(position.lng)
        ]
    );
}


// ============================================================
// COPY TRACKING NUMBER
// ============================================================

window.copyTrackingNumber =
    async function () {

        const element =
            document.getElementById(
                "trackingNumber"
            );


        if (!element) {
            return;
        }


        const trackingNumber =
            element.textContent.trim();


        try {

            await navigator.clipboard.writeText(
                trackingNumber
            );


            const button =
                document.getElementById(
                    "copyTrackingButton"
                );


            if (button) {

                const original =
                    button.textContent;


                button.textContent =
                    "Copied ✓";


                setTimeout(
                    () => {

                        button.textContent =
                            original;

                    },
                    1500
                );
            }


        } catch (error) {

            console.error(
                "Copy failed:",
                error
            );
        }
    };


// ============================================================
// ENTER KEY
// ============================================================

document.addEventListener(
    "DOMContentLoaded",
    () => {

        const input =
            document.getElementById(
                "trackingInput"
            );


        if (input) {

            input.addEventListener(
                "keydown",
                event => {

                    if (
                        event.key ===
                        "Enter"
                    ) {

                        window.trackPackage();
                    }
                }
            );
        }
    }
);


// ============================================================
// DATE PARSER
// ============================================================

function parseTrackFlowDate(
    value
) {

    if (!value) {
        return null;
    }


    // --------------------------------------------------------
    // JAVASCRIPT DATE
    // --------------------------------------------------------

    if (
        value instanceof Date
    ) {

        return Number.isNaN(
            value.getTime()
        )
            ? null
            : value;
    }


    // --------------------------------------------------------
    // FIRESTORE TIMESTAMP
    // --------------------------------------------------------

    if (
        value &&
        typeof value.toDate ===
        "function"
    ) {

        const date =
            value.toDate();


        return Number.isNaN(
            date.getTime()
        )
            ? null
            : date;
    }


    const text =
        String(value)
            .replace(
                /[—–]/g,
                "-"
            )
            .replace(
                /\s+/g,
                " "
            )
            .trim();


    // --------------------------------------------------------
    // TRACKFLOW DATE FORMAT
    //
    // September 29, 2026 - 8:26 AM
    // October 2, 2026 - 4:00 PM
    // --------------------------------------------------------

    const match =
        text.match(
            /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i
        );


    if (match) {

        const monthName =
            match[1];

        const day =
            Number(match[2]);

        const year =
            Number(match[3]);

        let hour =
            Number(match[4]);

        const minute =
            Number(match[5]);

        const ampm =
            match[6].toUpperCase();


        const monthDate =
            new Date(
                `${monthName} 1, ${year}`
            );


        if (
            Number.isNaN(
                monthDate.getTime()
            )
        ) {

            return null;
        }


        const month =
            monthDate.getMonth();


        // Convert 12-hour time to 24-hour time

        if (
            ampm === "PM" &&
            hour !== 12
        ) {

            hour += 12;
        }


        if (
            ampm === "AM" &&
            hour === 12
        ) {

            hour = 0;
        }


        const result =
            new Date(
                year,
                month,
                day,
                hour,
                minute,
                0,
                0
            );


        if (
            Number.isNaN(
                result.getTime()
            )
        ) {

            return null;
        }


        return result;
    }


    // --------------------------------------------------------
    // FALLBACK
    // --------------------------------------------------------

    const parsed =
        new Date(text);


    if (
        !Number.isNaN(
            parsed.getTime()
        )
    ) {

        return parsed;
    }


    return null;
}


// ============================================================
// FORMAT TIMELINE DATE
// ============================================================

function formatTrackFlowDate(
    date
) {

    if (
        !date ||
        Number.isNaN(
            date.getTime()
        )
    ) {

        return "—";
    }


    return new Intl.DateTimeFormat(
        "en-US",
        {
            month: "long",

            day: "numeric",

            year: "numeric",

            hour: "numeric",

            minute: "2-digit",

            hour12: true
        }
    ).format(date);
}


// ============================================================
// SET TEXT
// ============================================================

function setText(
    id,
    value
) {

    const element =
        document.getElementById(
            id
        );


    if (!element) {

        console.warn(
            `Element #${id} was not found.`
        );

        return;
    }


    element.textContent =
        value ?? "—";
}


// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHTML(
    value
) {

    return String(value)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}