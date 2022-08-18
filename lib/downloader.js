const Promise = require("bluebird");
const axios = require("axios");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const fs = Promise.promisifyAll(require("fs"));
const Url = require("url");
const qs = require("querystring");
const path = require("path");

// 调度器，控制发请求的频率
class Scheduler {
    constructor(count) {
        this.count = count;
        this.running = 0;
        this.queue = [];
        this.wait = 60;
    }

    async add(task) {
        if (this.running >= this.count) {
            await this.block();
        }
        try {
            ++this.running;
            const res = await task();
            this.succ()
            return res;
        } catch (e) {
            this.err()
            throw e;
        } finally {
            setTimeout(() => {
                --this.running;
                this.schedule()
            }, this.wait * 1000)
        }
    }
    err() {
        if (this.wait === 0) {
            this.wait += 1;
        }
        this.wait *= 2;
        this.wait = Math.min(this.wait, 60)
    }
    succ() {
        this.wait = Math.ceil(this.wait * 0.5);
        if (this.wait < 10 && this.wait > 0) {
            this.wait -= 1;
        }
    }
    block() {
        return new Promise((resolve) => this.queue.push(resolve))
    }
    schedule() {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next !== undefined) {
                next()
            }
        }
    }
    status() {
        return `线程数：${this.count} ，等待间隔（秒）： ${this.wait} ，等待任务数：${this.queue.length} ，运行数： ${this.running}`
    }
}

let scheduler = new Scheduler(5);

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
            responseType: "arraybuffer", timeout: 15000, headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246',
                "Referer": "http://www.wenku8.com"
            }
        })).data;
    }

    static async scheduleRawGet(url) {
        return await scheduler.add(async () => { return await this.rawGet(url) })
    }


    static async scheduleMustRawGet(url) {
        let retryLimit = 5
        let error = null
        while (retryLimit) {
            try {
                const res = await this.scheduleRawGet(url);
                return res
            } catch (err) {
                console.error(`failed to bin download ${url} because ${err.message} , retryLimit:${retryLimit} ${scheduler.status()}`);
                error = err;
                if (this.isNotFound(err)) {
                    break;
                }
                retryLimit = retryLimit - 1;

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
        let retryLimit = 5
        let error = null
        while (retryLimit) {
            try {
                const res = await this.scheduleGet(url);
                return res
            } catch (err) {
                console.error(`failed to download ${url} because ${err.message} , retryLimit:${retryLimit} , ${scheduler.status()}`);
                error = err;
                if (this.isNotFound(err)) {
                    break;
                }
                retryLimit = retryLimit - 1;
            }
        }
        throw error;
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
        let lastObj = await last;
        let thisCnt = lastObj.cnt
        console.log(
            `${this.name}[id=${this.id}]第${index + 1}章节已下载完成`,
            scheduler.status()
        );
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
                    console.log(
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
            name: $("b").eq(2).text(),
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
        console.log("start download", novel.name, scheduler.status());
        Novel.mkdirSingleNovel(novel.id, novel.name); // 创建本地目录

        if (novel.catalogUrl !== undefined) {
            let catalogBaseUrl = novel.catalogUrl.substring(
                0,
                novel.catalogUrl.lastIndexOf("/")
            );
            $ = await this.scheduleMustGet(novel.catalogUrl); // 获取某小说的章节目录页
            console.log("chapter loaded for novel", novel.name, scheduler.status())
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
            console.log(
                `${novel.name}[id=${novel.id}]全本已下载完成`,
                scheduler.status()
            );
        }
    }
}

// 你可以把下面的地址换成你想要下载的小说的目录页
module.exports = Novel;
