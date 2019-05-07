#!/usr/bin/env node

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
    });

    return Promise.all([loadTask, cameraTask]);
}

let main = async (opt) => {
    let url = opt.args.shift();

    const ua = await connect(opt);
    const page = await ua.newPage();

    if (opt.model) {
        await page.emulate(PDD[opt.model]);
    }

    await page.setExtraHTTPHeaders(opt.header);

    // warmup
    await page.setCacheEnabled(opt.cache);
    for (let i = 0; i < opt.warmup; i++) {
        await page.goto(url, {
            waitUntil: 'networkidle2',
    	    timeout: opt.timeout,
        });
    }
    await page.goto('about:blank');

    if (opt.trace) {
        await page.tracing.start({ path: opt.trace });
    }

    // inject delay
    await page.setRequestInterception(true);
    page.on('request', request => {
        let url = request.url();
        let ret = opt.delay.find(spec => spec[0].test(url));

        if (opt.verbose) {
            console.log(`URL: ${url}`);
        }

        if (ret) {
            let delay = ret[1];

            switch (delay) {
            case -1:
                if (opt.verbose || opt.debug > 0) {
                    console.log(`Blocking: ${url}`);
                }
                request.abort(404);
                break;
            case 0:
                delay = 86400; // handle "0 delay" as "BIG DELAY"
            default:
                if (opt.verbose || opt.debug > 0) {
                    console.log(`Delaying: ${url}`);
                }
                setTimeout(() => request.continue(), delay);
            }
        }
        else {
            request.continue();
        }
    });

    if (opt.outfile) {
        const har = new PuppeteerHar(page);
        await har.start();
    }

    // load page
    await capture(opt, page, url);

    if (opt.screenshot && opt.interval == 0) {
        await page.screenshot({ path: opt.screenshot, fullPage: opt.fullpage, type: 'jpeg' });
    }

    if (opt.trace) {
        await page.tracing.stop();
    }

    // save HAR data with additional metrics
    if (opt.outfile) {
        // TODO: Better to integrate lighthouse, if possible
        const data = await har.stop();
        const perf1 = await page._client.send('Performance.getMetrics');
        const perf2 = JSON.parse(await page.evaluate(() => JSON.stringify(window.performance.timing)));
        data['log']['pages'][0]['extra'] = [perf1, perf2];

        fs.writeFileSync(opt.outfile, JSON.stringify(data));
    }

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

commander
    .version('0.0.3')
    .option('-C, --chrome <arg>', 'Pass arg to Chrome', collect, [])
    .option('-D, --debug <level>', 'Set debug level', parseInt, 0)
    .option('-H, --header <header>', 'Add header', header_add, {})
    .option('-L, --headless', 'Run headless', false)
    .option('-T, --timeout <ms>', 'Timeout', parseInt, 0)
    .option('-c, --cache', 'Enable caching', false)
    .option('-d, --delay <ms>:<expr>', 'Apply delay to matching URL', delay_add, [])
    .option('-e, --endpoint <url>', 'Connect to given websocket endpoint')
    .option('-f, --fullpage', 'Take fullpage screenshot', false)
    .option('-i, --interval <ms>', 'Screenshot capture interval', parseInt, 0)
    .option('-m, --model <help|model>', 'Emulate device (ex: iPhone 6)')
    .option('-n, --warmup <N>', 'Fetch page N-times before measurement', parseInt, 0)
    .option('-o, --outfile <har>', 'HAR file to save')
    .option('-s, --screenshot <image>', 'Save screenshot (ex: image-%d.jpg)')
    .option('-t, --trace <tracelog>', 'Capture trace log')
    .option('-v, --verbose', 'Verbose message output')
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
