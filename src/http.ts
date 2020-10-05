import multer from 'multer';
import { Request, Response, Server, RequestHandler } from 'restify'
import { resolve as resolvePath } from 'path';
import RedisDatabase from './database';
import * as pdf from 'pdf2pic'
import { promises as fs } from 'fs'


const tmpDir = resolvePath(__dirname, '../tmp')
const convertSettings = {
    height: 1080,
    width: 1920,
    density: 330,
    savePath: tmpDir
}

const upload = multer({
    storage: multer.diskStorage({
        destination: tmpDir,
        filename: (_, file, cb) => {
            cb(null, file.originalname)
        }
    }),
})

export default class PPTXUploader {
    constructor(private server: Server, private database: RedisDatabase) {

        const multerMiddleware = upload.single('file')
        this.server.post('/upload', 
            (req, res, next) => multerMiddleware(req as any, res as any, next), 
            (req, res) => this.upload(req as any, res));
        this.server.get('/presentations', (req, res) => this.presentations(req, res))
        this.server.get('/presentations/:key/:page', (req, res) => this.page(req, res))
    }

    upload(req: Request & { file: { path: string, filename: string } }, res: Response) {
        const { path, filename } = req.file

        const registerFile = async () => {
            const file = await fs.readFile(path)
            await this.database.set(filename, file.toString('base64'))
            await this.database.hset(
                'slide_sets', 
                filename, 
                JSON.stringify({ name: filename }))
        }

        registerFile()
            .then(() => res.send({ success: true }))
            .catch((error: Error) => res.send({ success: false, error }));
    }

    presentations(_: Request, res: Response) {
        this.database.hgetall('slide_sets')
            .then(slide_sets => res.send({ 
                success: true, 
                items: Object.values(slide_sets).map(x => JSON.parse(x)) 
            }))
            .catch((error: Error) => res.send({ success: false, error }));
    }

    page(req: Request, res: Response) {
        const { key, page: pageStr } = req.params
        const page = parseInt(pageStr)
        const pdfPath = resolvePath(tmpDir, key)

        const loadPage = async () => {
            const inCache = await fs.stat(pdfPath).then(() => true).catch(() => false);
            if (!inCache) {
                console.log(`Download pdf file cache: ${key}`)
                const pdfEncoded = await this.database.get(key)
                if (!pdfEncoded) throw new Error('invalid key')
                await fs.writeFile(pdfPath, Buffer.from(pdfEncoded, 'base64'))
            }

            const imageCacheKey = `${key}_${page}`
            const imageCache = await this.database.get(imageCacheKey)

            if (imageCache) {
                console.log(`Using image from cache: ${imageCacheKey}`)
                return Buffer.from(imageCache, 'base64')
            }

            const converter = pdf.fromPath(pdfPath, convertSettings)
            const { base64: imageEncoded } : { base64?: string } = await converter(page, true);

            await this.database.set(imageCacheKey, imageEncoded)
            return Buffer.from(imageEncoded, 'base64')
        }

        loadPage()
            .then(buffer => res.sendRaw(buffer))
            .catch(err => {
                console.error(err)
                res.send(404)
            })
    }
}