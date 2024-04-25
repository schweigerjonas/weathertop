const express = require("express");
const dotenv = require("dotenv");
const pg = require("pg");
const session = require("express-session");
const bodyParser = require("body-parser");
const axios = require("axios");

/* Reading global variables from config file */
dotenv.config();
const PORT = process.env.PORT;

/*Connection to Database*/
const conString = process.env.DB_CON_STRING;
if (conString === undefined) {
    console.log("ERROR: DB_CON_STRING not set.");
    process.exit(1);
}

const dbConfig = {
    connectionString: conString,
    ssl: {rejectUnauthorized: false}
}
let dbClient = new pg.Client(dbConfig);
dbClient.connect();

/*
 *
 * Express setup
 *
*/

let app = express();

/*Sessions setup*/
app.use(session({
    secret: "This is a secret!",
    cookie: {maxAge: 3600000},
    resave: true,
    saveUninitialized: true
}));


/*Parser setup*/
let urlencodedParser = bodyParser.urlencoded({extended: true});


//turn on serving static files (required for delivering css to client)
app.use(express.static("public"));
//configure template engine
app.set("views", "views");
app.set("view engine", "pug");

/*
*
* Globale Variablen
*
* */

let mostRecentStationValues = [];
let queryJOIN = "SELECT station_id, user_id, station_name, latitude, longitude, entry_id, reading_time, weather, temperature, wind_speed, wind_direction, air_pressure FROM station_data JOIN station ON station_data.station_id = station.id";


/*Middleware*/
const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) {
        next();
    } else {
        res.redirect("/");
    }
};

app.use((req, res, next) => {
    initSession(req.session);
    next();
});

function initSession(session) {
    if (session.stations === undefined) {
        session.stations = [];
    }
}

/*
*
* Route Handlers
*
* */


app.get("/", (req, res) => {
    res.render("index", {page: "/"});
});

app.post("/login", urlencodedParser, async (req, res) => {
    let email = req.body.userEmailInput;
    let password = req.body.userPasswordInput;

    let query = "SELECT * FROM user_data WHERE email=$1 AND password=$2";

    await dbClient.query(query, [email, password], function (dbError, dbResponse) {
        if (dbError) {
            console.error(dbError);
        } else {
            if (dbResponse.rows.length === 0) {
                res.render("index", {login_error: "Ungültiges Passwort oder Email!", page: "/"});
            } else {
                req.session.user = dbResponse.rows[0].user_id;
                res.redirect("dashboard");
            }
        }
    });
});

app.get("/signup", (req, res) => {
    res.render("signup", {page: "/signup"});
});

app.post("/signup", urlencodedParser, async (req, res) => {
    let email = req.body.userEmailInput;
    let forename = req.body.userForenameInput;
    let surname = req.body.userSurnameInput;
    let password = req.body.userPasswordInput;

    let queryCheck = "SELECT * FROM user_data";
    let query = "INSERT INTO user_data (email, forename, surname, password) VALUES ($1, $2, $3, $4)";

    await dbClient.query(queryCheck, async function (dbError, dbCheckResponse) {
        if (dbError) {
            console.error(dbError);
        } else {
            let isDuplicate;
            for (let i = 0; i < dbCheckResponse.rows.length; i++) {
                if (email === dbCheckResponse.rows[i].email) {
                    isDuplicate = true;
                }
            }
            if (isDuplicate) {
                res.render("signup", {signup_error: "Email-Adresse wird bereits verwendet!", page: "/signup"});
            } else {
                await dbClient.query(query, [email, forename, surname, password], function (dbError, dbResponse) {
                    if (dbError) {
                        console.error(dbError);
                    } else {
                        res.redirect("/");
                    }
                });
            }

        }
    })

});

app.get("/dashboard", requireAuth, async (req, res) => {
    fetchMostRecentStationValues(req.session.user).then(() => {
        let stationIDs = [];
        for (let i = 0; i < mostRecentStationValues.length; i++) {
            stationIDs[i] = mostRecentStationValues[i].station_id;
        }

        res.render("dashboard", {
            station_data: mostRecentStationValues,
            stationIDs: stationIDs,
            page: "/dashboard"
        });
    });
});

app.post("/dashboard", urlencodedParser, async (req, res) => {
    let newStation = {
        stationName: req.body.stationNameInput,
        user_id: req.session.user,
        latitude: req.body.stationLatitudeInput,
        longitude: req.body.stationLongitudeInput
    }

    let deleteID = req.body.deleteStationID;

    let queryADD = "INSERT INTO station (user_id, station_name, latitude, longitude) VALUES ($1, $2, $3, $4)";
    let queryDeleteStationData = "DELETE FROM station_data WHERE station_id IN (SELECT id FROM station WHERE station.id=$1)";
    let queryDeleteStation = "DELETE FROM station WHERE id=$1";

    if (deleteID !== undefined) {
        await dbClient.query(queryDeleteStationData, [deleteID], async function (dbError, dbDELResponse) {
            if (dbError) {
                console.error(dbError);
            } else {
                await dbClient.query(queryDeleteStation, [deleteID], function (dbError, dbDELResponse) {
                    if (dbError) {
                        console.error(dbError);
                    } else {
                        res.redirect("dashboard");
                    }
                });
            }
        });
    } else {
        await dbClient.query(queryADD, [req.session.user, newStation.stationName, newStation.latitude, newStation.longitude], function (dbError, dbADDResponse) {
            if (dbError) {
                console.error(dbError);
            } else {
                req.session.stations.push(newStation);
                res.redirect("dashboard");
            }
        });
    }
});

app.get("/stations/:id", requireAuth, async (req, res) => {
    let stationID = req.params.id;
    let weather = "";
    let weatherIcon = "";
    let mostRecentStationValue = [];

    await dbClient.query(queryJOIN + " WHERE station_id = $1 ORDER BY entry_id DESC LIMIT 6", [stationID], async function (dbError, dbResponse) {
        if (dbError) {
            console.error(dbError);
        } else {
            if (dbResponse.rows.length > 0) {
                mostRecentStationValue.push(dbResponse.rows[0]);
                weather = getWeather(mostRecentStationValue[0].weather);
                weatherIcon = getWeatherIcon(mostRecentStationValue[0].weather);
                mostRecentStationValue[0].wind_direction = getWindDirection(mostRecentStationValue[0].wind_direction);
                mostRecentStationValue = await fetchMinMaxTrendValues(req.session.user, mostRecentStationValue);
                res.render("stations", {
                    most_recent_data: mostRecentStationValue,
                    stationWeather: weather,
                    weatherIcon: weatherIcon,
                    station_data: dbResponse.rows,
                    station_id: stationID,
                    page: "/stations"
                });
            } else {
                await dbClient.query("SELECT * FROM station WHERE id=$1", [stationID], async function (dbError, dbEmptyResponse) {
                    if (dbError) {
                        console.error(dbError);
                    } else {
                        mostRecentStationValue.push(dbEmptyResponse.rows[0]);
                        res.render("stations", {
                            most_recent_data: mostRecentStationValue,
                            station_data: dbResponse.rows,
                            station_id: stationID,
                            page: "/stations"
                        });
                    }
                });
            }
        }
    });
});

app.post("/stations/:id", urlencodedParser, async (req, res) => {
    let stationID = req.params.id;
    let readingTime = new Date().toString();

    let deleteEntryID = req.body.deleteEntryID;
    let automatedEntry = req.body.automatedEntry;

    let queryAdd = "INSERT INTO station_data (station_id, reading_time, weather, temperature, wind_speed, wind_direction, air_pressure) VALUES ($1, $2, $3, $4, $5, $6, $7)";
    let queryDelete = "DELETE FROM station_data WHERE entry_id = $1";                   //"Central European Standard Time" statisch

    if (deleteEntryID !== undefined) {
        await dbClient.query(queryDelete, [deleteEntryID], function (dbError, dbDELResponse) {
            if (dbError) {
                console.error(dbError);
            } else {
                res.redirect(stationID);
            }
        });
    } else if (automatedEntry !== undefined) {
        let reading = {};
        const lat = req.body.lat;
        const lon = req.body.lon;

        const requestUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=ea89dd0c88898655844ede681a0b6100`
        const result = await axios.get(requestUrl);

        if (result.status === 200) {
            reading = result.data;
        }
        let weather = reading.weather[0].id;
        let temperature = reading.main.temp;
        let windSpeed = reading.wind.speed;
        let windDirection = reading.wind.deg;
        let airPressure = reading.main.pressure;

        await dbClient.query(queryAdd, [stationID, readingTime, weather, temperature, windSpeed, windDirection, airPressure], function (dbError, dbAddResponse) {
            if (dbError) {
                console.error(dbError);
            } else {
                res.redirect(stationID);
            }
        });

    } else {
        let weather = req.body.stationWeatherInput;
        let temperature = req.body.stationTemperatureInput;
        let windSpeed = req.body.stationWindSpeedInput;
        let windDirection = req.body.stationWindDirectionInput;
        let airPressure = req.body.stationAirPressureInput;

        await dbClient.query(queryAdd, [stationID, readingTime, weather, temperature, windSpeed, windDirection, airPressure], function (dbError, dbAddResponse) {
            if (dbError) {
                console.error(dbError);
            } else {
                res.redirect(stationID);
            }
        });
    }
})
;

app.get("/logout", (req, res) => {
    req.session.destroy(function (err) {
        console.log("Session destroyed.");
    });
    res.render("logout", {page: "/logout"});
});


app.listen(PORT, function () {
    console.log(`Weathertop running and listening on port ${PORT}`);
});


/*
*
* Funktionen
*
* */

function getStations(user_id) {
    return new Promise((resolve, reject) => {
        let query = "SELECT * FROM station WHERE user_id = $1";
        dbClient.query(query, [user_id], function (dbError, dbStationsResponse) {
            if (dbError) {
                reject(dbError);
            } else {
                let stationArr = [];
                for (let i = 0; i < dbStationsResponse.rows.length; i++) {
                    let station = {
                        id: dbStationsResponse.rows[i].id,
                        name: dbStationsResponse.rows[i].station_name,
                        lat: dbStationsResponse.rows[i].latitude,
                        lon: dbStationsResponse.rows[i].longitude
                    }
                    stationArr.push(station);
                }
                session.stations = stationArr;
                resolve(session.stations);
            }
        });

    });
}

async function fetchStations(user_id) {
    try {
        session.stations = await getStations(user_id);
    } catch (error) {
        console.error(error);
    }
}

function getMostRecentStationValues(user_id) {
    return new Promise((resolve, reject) => {
        dbClient.query(queryJOIN, function (dbError, dbResponse) {
            if (dbError) {
                reject(dbError);
            } else {
                fetchStations(user_id).then(() => {
                    let mostRecentStationValues = [];
                    let emptyReadings = [];

                    session.stations.forEach(function (station) {
                        let mostRecentReading = null;

                        emptyReadings.push({
                            station_id: station.id,
                            station_name: station.name,
                            latitude: station.lat,
                            longitude: station.lon,
                            reading_time: null,
                            weather: null,
                            weatherIcon: null,
                            temperature: null,
                            wind_speed: null,
                            wind_direction: null,
                            air_pressure: null
                        });

                        let allStationValues = [...dbResponse.rows, ...emptyReadings];

                        for (let i = allStationValues.length - 1; i >= 0; i--) {
                            const row = allStationValues[i];
                            if (row.station_id === station.id && row.station_name === station.name && row.latitude === station.lat && row.longitude === station.lon) {
                                if (row.weather != null && row.wind_direction != null) {
                                    row.weatherIcon = getWeatherIcon(row.weather);
                                    row.weather = getWeather(row.weather);
                                    row.wind_direction = getWindDirection(row.wind_direction);
                                }

                                mostRecentReading = row;
                            }
                        }

                        if (mostRecentReading) {
                            mostRecentStationValues.push(mostRecentReading);
                        }
                    });
                    resolve(mostRecentStationValues);
                });
            }
        });
    });
}

async function fetchMostRecentStationValues(user_id) {
    try {
        mostRecentStationValues = await getMostRecentStationValues(user_id);
        await fetchMinMaxTrendValues(user_id, mostRecentStationValues);

        return mostRecentStationValues;
    } catch (error) {
        console.error(error);
    }
}

async function fetchMinMaxTrendValues(user_id, valueArr) {
    try {
        valueArr = await fetchMinimumValues(user_id, valueArr);
        valueArr = await fetchMaximumValues(user_id, valueArr);
        valueArr = await fetchWeatherTrend(user_id, valueArr);

        return valueArr;
    } catch (error) {
        console.error(error);
    }
}

function getMinimumValues(user_id) {
    let query = "SELECT station.id AS station_id, MIN(station_data.temperature) AS mintemperature, MIN(station_data.wind_speed) AS minwindspeed, MIN(station_data.air_pressure) AS minairpressure FROM station_data INNER JOIN station ON station_data.station_id = station.id WHERE station.user_id = $1 GROUP BY station.id";
    return new Promise((resolve, reject) => {
        dbClient.query(query, [user_id], function (dbError, dbResponse) {
            if (dbError) {
                reject(dbError);
            } else {
                let minValues = dbResponse.rows.map(row => ({
                    station_id: row.station_id,
                    minTemperature: row.mintemperature,
                    minWindSpeed: row.minwindspeed,
                    minAirPressure: row.minairpressure
                }));
                resolve(minValues);
            }
        });
    });
}

async function fetchMinimumValues(user_id, valueArr) {
    try {
        let minValues = await getMinimumValues(user_id);

        valueArr.forEach(station => {
            let matchingMinimum = minValues.find(minimum => minimum.station_id === station.station_id);
            if (matchingMinimum) {
                station.minTemperature = matchingMinimum.minTemperature;
                station.minWindSpeed = matchingMinimum.minWindSpeed;
                station.minAirPressure = matchingMinimum.minAirPressure;
            }
        });
        return valueArr;
    } catch (error) {
        console.error(error);
    }
}

function getMaximumValues(user_id) {
    let query = "SELECT station.id AS station_id, MAX(station_data.temperature) AS maxtemperature, MAX(station_data.wind_speed) AS maxwindspeed, MAX(station_data.air_pressure) AS maxairpressure FROM station_data INNER JOIN station ON station_data.station_id = station.id WHERE station.user_id = $1 GROUP BY station.id";
    return new Promise((resolve, reject) => {
        dbClient.query(query, [user_id], function (dbError, dbResponse) {
            if (dbError) {
                reject(dbError);
            } else {
                let maxValues = dbResponse.rows.map(row => ({
                    station_id: row.station_id,
                    maxTemperature: row.maxtemperature,
                    maxWindSpeed: row.maxwindspeed,
                    maxAirPressure: row.maxairpressure
                }));
                resolve(maxValues);
            }
        });
    });
}

async function fetchMaximumValues(user_id, valueArr) {
    try {
        let maxValues = await getMaximumValues(user_id);

        valueArr.forEach(station => {
            let matchingMaximum = maxValues.find(maximum => maximum.station_id === station.station_id);
            if (matchingMaximum) {
                station.maxTemperature = matchingMaximum.maxTemperature;
                station.maxWindSpeed = matchingMaximum.maxWindSpeed;
                station.maxAirPressure = matchingMaximum.maxAirPressure;
            }
        });

        return valueArr;
    } catch (error) {
        console.error(error);
    }
}

function getWeatherTrend(user_id) {
    let query = "SELECT * FROM station WHERE user_id = $1";
    return new Promise((resolve, reject) => {
        dbClient.query(query, [user_id], async function (dbError, dbResponse) {
            if (dbError) {
                reject(dbError);
            } else {
                let isRising = [];

                for (let i = 0; i < dbResponse.rows.length; i++) {
                    let station = dbResponse.rows[i];
                    let stationTrend = {
                        station_id: station.id,
                        temperatureTrend: null,     //Gleichheit -> steigend
                        windSpeedTrend: null,
                        airPressureTrend: null
                    };

                    let latestReadings = await fetchLatestReadings(station.id);

                    if (latestReadings.length === 2) {
                        let mostRecentReading = latestReadings[0];
                        let secondMostRecentReading = latestReadings[1];

                        if (mostRecentReading.temperature === secondMostRecentReading.temperature) {
                            stationTrend.temperatureTrend = "arrow-right-temperature.svg";
                        } else {
                            if (mostRecentReading.temperature >= secondMostRecentReading.temperature) {
                                stationTrend.temperatureTrend = "arrow-up-right-temperature.svg";
                            } else {
                                stationTrend.temperatureTrend = "arrow-down-right-temperature.svg";
                            }
                        }

                        if (mostRecentReading.wind_speed === secondMostRecentReading.wind_speed) {
                            stationTrend.windSpeedTrend = "arrow-right-windspeed.svg";
                        } else {
                            if (mostRecentReading.wind_speed >= secondMostRecentReading.wind_speed) {
                                stationTrend.windSpeedTrend = "arrow-up-right-windspeed.svg";
                            } else {
                                stationTrend.windSpeedTrend = "arrow-down-right-windspeed.svg";
                            }
                        }

                        if (mostRecentReading.air_pressure === secondMostRecentReading.air_pressure) {
                            stationTrend.airPressureTrend = "arrow-right-airpressure.svg";
                        } else {
                            if (mostRecentReading.air_pressure >= secondMostRecentReading.air_pressure) {
                                stationTrend.airPressureTrend = "arrow-up-right-airpressure.svg";
                            } else {
                                stationTrend.airPressureTrend = "arrow-down-right-airpressure.svg";
                            }
                        }
                    }
                    isRising.push(stationTrend);
                }
                resolve(isRising);
            }
        });
    });
}

async function fetchLatestReadings(station_id) {
    let query = "SELECT * FROM station_data WHERE station_id = $1 ORDER BY entry_id DESC LIMIT 2";
    return new Promise((resolve, reject) => {
        dbClient.query(query, [station_id], function (dbError, dbResponse) {
            if (dbError) {
                reject(dbError);
            } else {
                resolve(dbResponse.rows);
            }
        });
    });
}

async function fetchWeatherTrend(user_id, valueArr) {
    try {
        let weatherTrend = await getWeatherTrend(user_id);

        valueArr.forEach(station => {
            let matchingTrend = weatherTrend.find(trend => trend.station_id === station.station_id);
            if (matchingTrend) {
                station.temperatureTrend = matchingTrend.temperatureTrend;
                station.windSpeedTrend = matchingTrend.windSpeedTrend;
                station.airPressureTrend = matchingTrend.airPressureTrend;
            }
        });

        return valueArr;
    } catch (error) {
        console.error(error);
    }
}

function getWeather(weatherCode) {
    let weatherName = "";

    if (weatherCode < 300) {
        weatherName = "Gewitter";
    } else if (300 <= weatherCode && weatherCode < 500) {
        weatherName = "Nieselregen";
    } else if (500 <= weatherCode && weatherCode < 600) {
        weatherName = "Regen";
    } else if (600 <= weatherCode && weatherCode < 700) {
        weatherName = "Schnee";
    } else if (700 <= weatherCode && weatherCode < 800) {
        weatherName = "Atmosphäre";
    } else if (weatherCode === 800) {
        weatherName = "Sonnig";
    } else if (weatherCode > 800) {
        weatherName = "Wolkig";
    }

    return weatherName;
}

function getWeatherIcon(weatherCode) {
    let weatherIconName = "";

    if (weatherCode < 300) {
        weatherIconName = "weather-lightning.svg";
    } else if (300 <= weatherCode && weatherCode < 500) {
        weatherIconName = "weather-drizzle.svg";
    } else if (500 <= weatherCode && weatherCode < 600) {
        weatherIconName = "weather-rain.svg";
    } else if (600 <= weatherCode && weatherCode < 700) {
        weatherIconName = "weather-snow.svg";
    } else if (700 <= weatherCode && weatherCode < 800) {
        weatherIconName = "weather-atmosphere.svg";
    } else if (weatherCode === 800) {
        weatherIconName = "weather-sun.svg";
    } else if (weatherCode > 800) {
        weatherIconName = "weather-clouds.svg";
    }

    return weatherIconName;
}

function getWindDirection(windDirection) {
    let windDirectionName = "";

    if (windDirection >= 348.75 && windDirection < 11.25)
        windDirectionName = "Nord"
    else if (windDirection >= 11.25 && windDirection < 33.75)
        windDirectionName = "Nord Nordost"
    else if (windDirection >= 33.75 && windDirection < 56.25)
        windDirectionName = "Nordost"
    else if (windDirection >= 56.25 && windDirection < 78.75)
        windDirectionName = "Ost Nordost"
    else if (windDirection >= 78.75 && windDirection < 101.25)
        windDirectionName = "Ost"
    else if (windDirection >= 101.25 && windDirection < 123.75)
        windDirectionName = "Ost Südost"
    else if (windDirection >= 123.75 && windDirection < 146.25)
        windDirectionName = "Südost"
    else if (windDirection >= 146.25 && windDirection < 168.75)
        windDirectionName = "Süd Südost"
    else if (windDirection >= 168.75 && windDirection < 191.25)
        windDirectionName = "Süd"
    else if (windDirection >= 191.25 && windDirection < 213.75)
        windDirectionName = "Süd Südwest"
    else if (windDirection >= 213.75 && windDirection < 236.25)
        windDirectionName = "Südwest"
    else if (windDirection >= 236.25 && windDirection < 258.75)
        windDirectionName = "West Südwest"
    else if (windDirection >= 258.75 && windDirection < 281.25)
        windDirectionName = "West"
    else if (windDirection >= 281.25 && windDirection < 303.75)
        windDirectionName = "West Nordwest"
    else if (windDirection >= 303.75 && windDirection < 326.25)
        windDirectionName = "Nordwest"
    else if (windDirection >= 326.25 && windDirection < 348.75)
        windDirectionName = "Nord Nordwest"

    return windDirectionName;
}

