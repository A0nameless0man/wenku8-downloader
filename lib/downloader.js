const Promise = require("bluebird");
const axios = require("axios");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const fs = Promise.promisifyAll(require("fs"));
const Url = require("url");
const qs = require("querystring");
const path = require("path");
const { getLogger } = require("log4js");

const novellogger = getLogger("novel");
novellogger.level = "debug";

// 调度器，控制发请求的频率
class Scheduler {
    constructor(count) {
        this.count = count;
        this.running = 0;
        this.finished = 0;
        this.queue = [];
        this.wait = 0;
        this.waitmin = 1;
        this.waitmax = 300 * count;
        this.tokens = new Array(count).fill(1, 0, count);
        this.tick()
    }

    async add(task) {
        const t = await this.block();
        this.running++
        try {
            const res = await task();
            this.succ()
            return res;
        } catch (e) {
            this.err()
            throw e;
        } finally {
            this.finished++
            // await this.waitf(this.wait * (Math.random() + 0.5))
            // this.schedule(t)
        }
    }
    err() {
        if (this.wait < 1) {
            this.wait = 1;
        } else {
            this.wait *= 2;
        }
        this.wait = Math.min(this.wait, this.waitmax)
    }
    succ() {
        if (this.wait <= 10) {
            this.wait -= 1;
        } else {
            this.wait = Math.ceil(this.wait * 0.5);
        }
        this.wait = Math.max(this.wait, this.waitmin)
    }
    block() {
        const t = this.tokens.pop()
        if (t != undefined) {
            return Promise.resolve(t)
        } else {
            return new Promise((resolve) => this.queue.push(resolve))
        }
    }
    async schedule(t) {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next !== undefined) {
                next(t)
            } else {
                this.tokens.push(t);
            }
        } else if (this.tokens.length < this.count) {
            this.tokens.push(t);
        }
    }
    async tick() {
        while (this.count != 0) {
            this.schedule(1)
            await this.waitf(this.wait * (Math.random() + 0.5) / this.count)
        }
    }
    async waitf(time) {
        return new Promise((resolve) => { setTimeout(resolve, time * 1000) })
    }
    status() {
        var qps = ""
        if (this.count > this.wait) {
            qps = `${this.count / this.wait} req/s`
        } else {
            qps = `${this.wait / this.count} s/req`
        }
        return `线程数：${this.count} ，流控： ${qps} ，等待任务数：${this.queue.length} ，运行数：${this.running - this.finished} `
    }
}

let scheduler = new Scheduler(10);

class Novel {
    constructor(obj) {
        Object.assign(this, obj);
        this.imageLoaded = new Set();
    }

    static isNotFound(err) {
        return err instanceof Error && err.message.indexOf("404") !== -1
    }

    static async rawGet(url) {
        return (await axios.get(url, {
            responseType: "arraybuffer", timeout: 5000, headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246',
                "Referer": "http://www.wenku8.com",
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                // "cache-control": "max-age=0",
                // "if-modified-since": "Mon, 02 May 2022 12:27:34 GMT",
                // "if-none-match": "W/\"626fce36-8555\"",
                "sec-ch-ua": "\"Chromium\";v=\"104\", \" Not A;Brand\";v=\"99\", \"Google Chrome\";v=\"104\"",
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": "\"Windows\"",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1",
                // "cookie": "Hm_lvt_b74ae3cad0d17bb613b120c400dcef59=1660836996; Hm_lpvt_b74ae3cad0d17bb613b120c400dcef59=1660836996; UM_distinctid=17fd647614e837-0b98cbd1bbf94d-9771a3f-384000-17fd647614fd7c; CNZZDATA1259916661=2032280257-1648565539-%7C1650453115; __51vcke__1xxUP7WYCXbghcPV=12e00eda-2582-596f-86d4-7dc122ed3b7b; __51vuft__1xxUP7WYCXbghcPV=1651033141520; __51vcke__1xpAUPUjtatG3hli=82f05897-d793-5634-bd4b-c59781546f73; __51vuft__1xpAUPUjtatG3hli=1651139204692; __51vcke__1xxUOVWpBVjORhzY=3a8a7c49-74e7-5b26-9a8f-56b7a0f27d79; __51vuft__1xxUOVWpBVjORhzY=1651247192898; __51uvsct__1xtyjOqSZ75DRXC0=1; __51vcke__1xtyjOqSZ75DRXC0=da54b57a-768e-5f56-8532-54591439f00c; __51vuft__1xtyjOqSZ75DRXC0=1653220868124; __51uvsct__1xxUOVWpBVjORhzY=8; Hm_lvt_acfbfe93830e0272a88e1cc73d4d6d0f=1651247193,1651320616,1653014398; __51uvsct__1xxUP7WYCXbghcPV=10; __51uvsct__1xpAUPUjtatG3hli=23; Hm_lvt_d72896ddbf8d27c750e3b365ea2fc902=1659150201,1659215691,1659880416; jieqiUserInfo=jieqiUserId%3D972837%2CjieqiUserName%3Dcapnemo%2CjieqiUserGroup%3D3%2CjieqiUserVip%3D0%2CjieqiUserPassword%3D57d96126881a86bb94df6968e5b2ba3c%2CjieqiUserName_un%3Dcapnemo%2CjieqiUserHonor_un%3D%26%23x666E%3B%26%23x901A%3B%26%23x4F1A%3B%26%23x5458%3B%2CjieqiUserGroupName_un%3D%26%23x666E%3B%26%23x901A%3B%26%23x4F1A%3B%26%23x5458%3B%2CjieqiUserLogin%3D1660836993; jieqiVisitInfo=jieqiUserLogin%3D1660836993%2CjieqiUserId%3D972837; PHPSESSID=19dmbed7pmfiflon8rk55nb3nch3ga73; Hm_lpvt_d72896ddbf8d27c750e3b365ea2fc902=1660836996"
            }
        })).data;
    }

    static async scheduleRawGet(url) {
        return await scheduler.add(async () => { return await this.rawGet(url) })
    }


    static async scheduleMustRawGet(url) {
        const retryLimit = 5000
        let retryCnt = 0
        let error = null
        while (retryCnt <= retryLimit) {
            try {
                const res = await this.scheduleRawGet(url);
                return res
            } catch (err) {
                novellogger.error(`failed to bin download ${url} because ${err.message} , retryLimit:${retryCnt}/${retryLimit} ${scheduler.status()}`);
                error = err;
                if (this.isNotFound(err)) {
                    break;
                }
                retryCnt++
            }
        }
        throw error;
    }

    static async get(url) {
        let res = await this.rawGet(url)
        let $ = cheerio.load(iconv.decode(res, "gbk"));
        return $;
    }

    static async scheduleGet(url) {
        return await scheduler.add(async () => { return await this.get(url) })
    }
    static async scheduleMustGet(url) {
        const retryLimit = 5000
        let retryCnt = 0
        let error = null
        while (retryCnt <= retryLimit) {
            try {
                const res = await this.scheduleGet(url);
                return res
            } catch (err) {
                novellogger.error(`failed to download ${url} because ${err.message} , retryLimit:${retryCnt}/${retryLimit} , ${scheduler.status()}`);
                error = err;
                if (this.isNotFound(err)) {
                    break;
                }
                retryCnt++
            }
        }
        throw error
    }

    static purifyContent(s) {
        return s.
            replace("&nbsp;", "").
            replace("更多精彩热门日本轻小说、动漫小说，轻小说文库(http://www.wenku8.com) 为你一网打尽！", "").
            replace("本文来自 轻小说文库(http://www.wenku8.com)", "").
            replace("台版 转自 轻之国度", "").
            replace(
                "最新最全的日本动漫轻小说 轻小说文库(http://www.wenku8.com) 为你一网打尽！",
                ""
            ).replace("★☆★☆★☆轻小说文库(Www.WenKu8.com)☆★☆★☆★", "");
    }

    static async getChapter(url) {
        let $$ = await this.scheduleMustGet(url);
        if ($$('#contentmain span').first().text().trim() == 'null') {
            let content = ""
            let images = []
            let v = url.substring(0, url.lastIndexOf(".")).split("/")
            try {
                let resp = await this.scheduleMustRawGet(`http://dl.wenku8.com/pack.php?aid=${v.slice(-2)[0]}&vid=${v.slice(-1)[0]}`)
                let html = cheerio.load(iconv.decode(resp, "utf-8"))
                content = html.text()
            } catch (e) {
                if (this.isNotFound(e)) {
                    let resp = await this.scheduleMustRawGet(`http://dl.wenku8.com/packtxt.php?aid=${v.slice(-2)[0]}&vid=${v.slice(-1)[0]}&charset=utf-8`)
                    content = iconv.decode(resp, "UTF-16LE")
                } else {
                    throw e
                }
            }
            let picReg = /https?:\/\/pic\.wenku8\.com\/pictures\/[\/0-9]+.jpg/g
            let picRegL = /https?:\/\/pic\.wenku8\.com\/pictures\/[\/0-9]+.jpg\([0-9]+K\)/g
            images = content.match(picReg) ?? []
            content = content.replace(picRegL, "")
            content = this.purifyContent(content)
            return { content, images }
        } else {
            let content = $$("#content")
                .text()
            content = this.purifyContent(content)
            let images = $$("img").map(function (i, imgEle) {
                let imgsrc = imgEle.attribs.src
                return imgsrc
            }).get();
            return { content, images };
        }
    }

    static async mkdirSingleNovel(id, name) {
        try {
            await fs.stateAsync(path.join(process.cwd(), `./novels/${id}-${name}`));
            // await fs.statAsync(`./novels/${id}-${name}`)
        } catch (e) {
            await fs.mkdirAsync(path.join(process.cwd(), `./novels/${id}-${name}`), { recursive: true });
            // await fs.mkdirAsync(`./novels/${id}-${name}`)
        }
    }

    getFirstLast() {
        return Promise.resolve({ content: "", cnt: 1 })
    }

    async downloadChapter(index, title, url, last) {
        let { content, images } = (await Novel.getChapter(url));
        novellogger.info(
            `${this.name}[id=${this.id}]第${index + 1}章节已下载完成`,
            scheduler.status()
        );
        let lastObj = await last;
        let thisCnt = lastObj.cnt
        if (!(await last).content.includes(content)) {
            if (images) {
                images = await Promise.all(images.map(async (image) => {
                    let imgname = image.split("/").slice(-1)[0];
                    if (this.imageLoaded.has(imgname)) {
                        return "";
                    }
                    this.imageLoaded.add(imgname);
                    let resp = await Novel.scheduleMustRawGet(image);
                    await fs.writeFileAsync(
                        path.join(
                            process.cwd(),
                            `./novels/${this.id}-${this.name}/${imgname}`
                        ),
                        resp
                    );
                    novellogger.info(
                        `${this.name}[id=${this.id}]第${index + 1}章节图片${imgname}已下载完成`,
                        scheduler.status()
                    );
                    return imgname
                }))
                images = images.map((v) => v ? `![](${v})` : "")
                content += images.join('\n')
            }
            await fs.writeFileAsync(
                path.join(
                    process.cwd(),
                    `./novels/${this.id}-${this.name}/${thisCnt}.md`
                ),
                `# ${title}\n` + content
            );
            thisCnt += 1;

        }
        return { content: content, cnt: thisCnt }
    }

    /**
     *
     *
     * @static
     * @param {*} url
     * @memberof Novel
     */
    static async download(url) {
        if (!fs.existsSync(path.join(process.cwd(), "novels"))) {
            fs.mkdirSync(path.join(process.cwd(), "novels"));
        }

        let $ = await this.scheduleMustGet(url); // 获取某小说的主页

        let id; // 小说的完整编号
        let backUrl = url.substring(url.lastIndexOf("/") + 1, url.lastIndexOf(".")); // 小说的编号
        id =
            backUrl === "articleinfo"
                ? `1-${qs.parse(Url.parse(url).query).id}`
                : `2-${backUrl}`;

        const novel = new Novel({
            id,
            name: $("#content > div:nth-child(1) > table:nth-child(1) > tbody > tr:nth-child(1) > td > table > tbody > tr > td:nth-child(1) > span > b").text(),
            desc: $(".hottext:nth-of-type(4)").nextAll("span").text(),
            indexUrl: url,
            catalogUrl: $("#content")
                .children()
                .first()
                .children()
                .eq(5)
                .children()
                .children()
                .first()
                .find("a")
                .attr("href"),
        });
        novellogger.info("start download", novel.name, scheduler.status());
        Novel.mkdirSingleNovel(novel.id, novel.name); // 创建本地目录

        if (novel.catalogUrl !== undefined) {
            let catalogBaseUrl = novel.catalogUrl.substring(
                0,
                novel.catalogUrl.lastIndexOf("/")
            );
            $ = await this.scheduleMustGet(novel.catalogUrl); // 获取某小说的章节目录页
            novellogger.info("chapter loaded for novel", novel.name, scheduler.status())
            let last = novel.getFirstLast()
            const chapters = []
            for (let [index, item] of Object.entries($("table td a"))) {
                index = parseInt(index);
                let href = $(item).attr("href");
                if (href) {
                    let url = `${catalogBaseUrl}/${href}`; // 该小说的某章节的路径
                    let title = $(item).text();
                    last = novel.downloadChapter(index, title, url, last);
                    chapters.push(last)
                }
            }
            await Promise.all(chapters);
            novellogger.info(
                `${novel.name}[id=${novel.id}]全本已下载完成`,
                scheduler.status()
            );
        }
    }

    static clean() {
        scheduler.count = 0
    }
}

// 你可以把下面的地址换成你想要下载的小说的目录页
module.exports = Novel;
