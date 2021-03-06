#!/usr/bin/env node
//
// TODO:
// - support reload test
// - check visual status, position, and area size of each element in final render result
// -- not sure how to handle text (JS, CSS) assets
// - merge lighthouse for speedindex and other extended metrics
// 

//
// See also;
// - https://michaljanaszek.com/blog/test-website-performance-with-puppeteer
// - https://github.com/sitespeedio/chrome-har
// - https://github.com/GoogleChrome/lighthouse/blob/HEAD/docs/readme.md#using-programmatically
// - https://github.com/GoogleChrome/lighthouse/issues/4634
// - https://chromedevtools.github.io/devtools-protocol/tot/Performance
//

const PPT = require('puppeteer');
const PDD = require('puppeteer/DeviceDescriptors');
const PuppeteerHar = require('puppeteer-har');
const commander = require('commander');
const fs = require('fs');

let connect = async (opt) => {
    if (opt.endpoint) {
        return await PPT.connect({
            browserWSEndpoint: opt.endpoint,
        });
    }
    else {
        return await PPT.launch({
            headless: opt.headless,
            args: [
                ...opt.chrome,
                '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors',
                '--no-first-run', '--no-default-browser-check'
            ],
        });
    }
};

let delay = async ms => new Promise(ok => setTimeout(ok, ms));

let capture = async (opt, page, url) => {
    let cameraStop = false;
    let cameraLoop = async (opt, page, elapsed=0) => {
        if (! opt.screenshot || opt.interval == 0) return;

        // save screenshot
        let savefile = opt.screenshot.replace("%d", ('000000' + elapsed).substr(-6));
        let savetask = page.screenshot({ path: savefile, fullPage: opt.fullpage, type: 'jpeg' });

        if (cameraStop) {
            if (opt.debug > 0) console.log(`page loaded. saving screenshots...`);
            return savetask;
        }

        // revursively chain to next capture event
        if (opt.debug > 0) console.log(`taking more...`);
        let nexttask = delay(opt.interval).then(() => {
            return cameraLoop(opt, page, elapsed + opt.interval);
        });
        return Promise.all([savetask, nexttask]);
    };

    // run camera and load task in parallel
    let cameraTask = cameraLoop(opt, page);
    let loadTask = page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: opt.timeout,
    }).then(ret => {
        cameraStop = true;
    }).catch(err => {
        if (opt.debug > 0) console.log('Interrupted page load - possible timeout.');
        cameraStop = true;
    });

    return Promise.all([loadTask, cameraTask]);
}

let main = async (opt) => {
    let url = opt.args.shift();
    let plugins = opt.plugin.map(file => require(file));
    let delay_time = {};
    let delay_count = {};

    const ua = await connect(opt);
    const page = await ua.newPage();

    await page.setViewport(parseWH(opt.screensize));
    if (opt.model) {
        await page.emulate(PDD[opt.model]);
    }

    await page.setExtraHTTPHeaders(opt.header);
    await page.setCacheEnabled(opt.cache);

    // hook: setup-stage
    plugins.forEach(plugin => plugin.setup && plugin.setup(opt, url, ua, page));

    // warmup
    for (let i = 0; i < opt.prewarm; i++) {
        await page.goto(url, {
            waitUntil: 'networkidle2',
    	    timeout: opt.timeout,
        });
    }
    await page.goto('about:blank');

    // inject delay
    if (opt.delay.length > 0) {
        // NOTE: This disables caching (conflicts with --cache)
        await page.setRequestInterception(true);
        page.on('request', request => {
            let url = request.url();

            if (opt.debug > 1) {
                console.log(`URL: ${url}`);
            }

            let ret = opt.delay.findIndex(spec => spec[0].test(url));
            if (ret < 0) {
                request.continue();
                return;
            }

            // check match count with max match limit
            delay_count[ret] = delay_count[ret] ? delay_count[ret] + 1 : 1;
            if (opt.maxMatch > 0 && delay_count[ret] > opt.maxMatch) {
                if (opt.debug > 0) {
                    console.log(`Skipping: ${url}`);
                }
                request.continue();
                return;
            }

            // take delay/block action
            let delay = opt.delay[ret][1];
            switch (delay) {
            case -1:
                if (opt.debug > 0) {
                    console.log(`Blocking: ${url}`);
                }
                request.abort(404);
                break;
            case 0:
                delay = 300000; // handle "0 delay" as "BIG DELAY of 300s"
            default:
                if (opt.debug > 0) {
                    console.log(`Delaying: ${url}`);
                }
                delay_time[url] = delay;
                setTimeout(() => request.continue(), delay);
            }
        });
    }

    if (opt.trace) {
        await page.tracing.start({ path: opt.trace });
    }

    const har = new PuppeteerHar(page);
    await har.start();

    // hook: before-stage
    plugins.forEach(plugin => plugin.before && plugin.before(opt, url, ua, page));

    // load page
    // TODO: Consider adding second-time load measurement
    await capture(opt, page, url);

    // hook: after-stage
    plugins.forEach(plugin => plugin.after && plugin.after(opt, url, ua, page));

    if (opt.screenshot && opt.interval == 0) {
        await page.screenshot({ path: opt.screenshot, fullPage: opt.fullpage, type: 'jpeg' });
    }

    if (opt.trace) {
        await page.tracing.stop();
    }

    // DEBUG: for puppeteer-har/chrome-har debugging
    //fs.writeFileSync('debug.json', JSON.stringify(har.events));

    let data = await har.stop();

    // TODO: Better to integrate lighthouse, if possible
    let perf1 = await page._client.send('Performance.getMetrics');
    let perf2 = JSON.parse(await page.evaluate(() => JSON.stringify(window.performance.timing)));
    let perf3 = JSON.parse(await page.evaluate(() => JSON.stringify(window.performance.getEntriesByType('paint'))));
    data['log']['pages'][0]['extra'] = {
        metrics: perf1['metrics'],
        timing: perf2,
        paint: perf3,
    };

    // record delay in HAR (also seems to be counted in "_queued" field)
    let assets = data['log']['entries'];
    for (let i = 0; i < assets.length; i++) {
        let url = assets[i]['request']['url'];
        if (delay_time[url] > 0) {
            assets[i]['timings']['_delayed'] = delay_time[url];
        }
    }

    // hook: process-stage
    plugins.forEach(plugin => plugin.process && plugin.process(opt, url, ua, page, data));

    // save HAR data with additional metrics
    if (opt.outfile) {
        fs.writeFileSync(opt.outfile, JSON.stringify(data));
    }

    // hook: cleanup-stage
    plugins.forEach(plugin => plugin.cleanup && plugin.cleanup(opt, url, ua, page, data));

    if (! opt.endpoint) {
        await ua.close();
    }
};

let header_add = (header, memo) => {
    let i = header.indexOf(':');
    let key = header.substr(0, i);
    let val = header.substr(i + 1);
    memo[key] = val;
    return memo;
};

let collect = (val, memo) => {
    memo.push(val);
    return memo;
};

let delay_add = (spec, memo) => {
    let i = spec.indexOf(':');
    let delay = parseInt(spec.substr(0, i));
    let expr = new RegExp(spec.substr(i + 1));
    memo.push([expr, delay]);
    return memo;
};

let parseWH = (spec) => {
    let wh = spec.split('x').map(v => parseInt(v));
    return { width: wh[0], height: wh[1] };
};

commander
    .version('0.0.4')
    .option('-C, --chrome <arg>', 'Pass arg to Chrome', collect, [])
    .option('-D, --debug <level>', 'Set debug level', parseInt, 0)
    .option('-H, --header <header>', 'Add HTTP header', header_add, {})
    .option('-L, --headless', 'Run headless', false)
    .option('-M, --model <help|model>', 'Emulate device (ex: iPhone 6)')
    .option('-P, --plugin <file>', 'Add plugin', collect, [])
    .option('-S, --screensize <WxH>', 'Screen size', '1920x1080')
    .option('-T, --timeout <ms>', 'Timeout', parseInt, 0)
    .option('-X, --extra <arg>', 'Pass arg to plugins', collect, [])
    .option('-c, --cache', 'Enable caching', false)
    .option('-d, --delay <ms>:<expr>', 'Apply delay to matching URL', delay_add, [])
    .option('-e, --endpoint <url>', 'Connect to given websocket endpoint')
    .option('-f, --fullpage', 'Take fullpage screenshot', false)
    .option('-i, --interval <ms>', 'Screenshot capture interval', parseInt, 0)
    .option('-m, --max-match <N>', 'Stop delaying after N-time match for each entry', parseInt, 0)
    .option('-n, --repeat <N>', 'Repeat measurement N-times (TBD)', parseInt, 1)
    .option('-o, --outfile <har>', 'HAR file to save')
    .option('-p, --prewarm <N>', 'Fetch page N-times before measurement', parseInt, 0)
    .option('-s, --screenshot <image>', 'Save screenshot (ex: image-%d.jpg)')
    .option('-t, --trace <tracelog>', 'Capture trace log')
    .parse(process.argv);

if (commander.model == 'help') {
    console.log('# supported models');
    for (let k in PDD) {
        if (k >= 0) continue;
        console.log(k);
    }
    process.exit(0);
}

main(commander);
