/* ===========================================================================
 * DVG Intelligence — weather
 * ---------------------------------------------------------------------------
 * Open-Meteo, which needs no API key and no billing.
 *
 * WHY THIS EXISTS: the panel already stored a weather blob on every event, but
 * that was the reading AT THE MOMENT a staff member logged something — so a
 * 95°F afternoon recorded at 9pm looked like 70°F. Across the whole history
 * that squeezed the range to 66-84°F and the temperature/demand correlation
 * came out at 0.06, i.e. noise. These functions fetch the real DAILY HIGH for
 * each date instead, which is the number that actually drives gelato demand.
 * ========================================================================= */
'use strict';

const WMO = {
    0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Icy fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    80: 'Rain showers', 81: 'Showers', 82: 'Heavy showers',
    95: 'Thunderstorm', 96: 'Storm + hail', 99: 'Severe storm'
};

const DAILY_VARS = 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code';

function shape(daily) {
    const out = {};
    const times = (daily && daily.time) || [];
    for (let i = 0; i < times.length; i++) {
        const code = daily.weather_code ? daily.weather_code[i] : null;
        const max = daily.temperature_2m_max ? daily.temperature_2m_max[i] : null;
        if (max == null) continue;              // day not yet reported
        out[times[i]] = {
            tempMaxF: Math.round(max),
            tempMinF: daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[i]) : null,
            precipIn: daily.precipitation_sum ? Math.round((daily.precipitation_sum[i] || 0) * 100) / 100 : 0,
            code: code,
            label: WMO[code] || 'Unknown'
        };
    }
    return out;
}

async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Open-Meteo ' + res.status + ' for ' + url);
    return res.json();
}

/* Historical daily weather. The archive lags roughly 5 days, so recent dates
 * are filled from the forecast endpoint's `past_days` window instead. */
async function fetchHistory(shop, startDate, endDate) {
    const base = `latitude=${shop.lat}&longitude=${shop.lon}`
        + `&daily=${DAILY_VARS}&temperature_unit=fahrenheit`
        + `&precipitation_unit=inch&timezone=${encodeURIComponent(shop.timezone)}`;

    const archive = await getJson(
        `https://archive-api.open-meteo.com/v1/archive?${base}`
        + `&start_date=${startDate}&end_date=${endDate}`
    ).catch(e => { console.warn('archive fetch failed', e.message); return null; });

    /* past_days maxes out at 92 on the forecast endpoint. */
    const recent = await getJson(
        `https://api.open-meteo.com/v1/forecast?${base}&past_days=92&forecast_days=7`
    ).catch(e => { console.warn('forecast fetch failed', e.message); return null; });

    /* Recent wins on overlap — it is the fresher observation. */
    return Object.assign({},
        archive ? shape(archive.daily) : {},
        recent ? shape(recent.daily) : {});
}

/* The next few days, for "what should we make" style questions. */
async function fetchForecast(shop, days) {
    const d = Math.max(1, Math.min(14, days || 7));
    const data = await getJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${shop.lat}&longitude=${shop.lon}`
        + `&daily=${DAILY_VARS}&temperature_unit=fahrenheit&precipitation_unit=inch`
        + `&timezone=${encodeURIComponent(shop.timezone)}&forecast_days=${d}`
    );
    return shape(data.daily);
}

module.exports = { WMO, fetchHistory, fetchForecast, shape };
