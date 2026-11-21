import multer from 'multer';
import { google } from 'googleapis';
import { Readable } from "stream";
import { uploadFileData } from '../services/upload.js';
import { deleteAssignment, getAssignmentStudent, getAssignmentTeacher } from '../services/assignment.js';
import { getStudentClass } from '../services/user.js';
import { Assignment } from '../models/index.js';
import { AppError } from '../utils/errorHandling.js';
import dotenv from "dotenv";

dotenv.config();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN
const destinationFolderId = process.env.DESTINATION_FOLDER_ID;

const upload = multer({
    storage: multer.memoryStorage(),
});

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

oauth2Client.setCredentials({
    refresh_token: REFRESH_TOKEN,
});

const SCOPES = ['https://www.googleapis.com/auth/drive'];


const getTokens = async (authorizationCode) => {
    try {
      const { tokens } = await oauth2Client.getToken(authorizationCode);
      const accessToken = tokens.access_token;
      const refreshToken = tokens.refresh_token;
  
      // Store the accessToken and refreshToken securely for future use
  
      console.log('Access Token:', accessToken);
      console.log('Refresh Token:', refreshToken);

    } catch (error) {
      console.error('Error retrieving tokens:', error);
    }
}

const createReadableStream = (buffer) => {
    const readable = new Readable();
    readable._read = () => {};
    readable.push(buffer);
    readable.push(null);
    return readable;
}


// One-off Drive setup (prints a refresh token to the server log). Off unless
// DRIVE_SETUP=true, so nobody can trigger it on the live server.
const driveSetupEnabled = () => process.env.DRIVE_SETUP === "true";

const authCallback = async (req, res) => {
    if (!driveSetupEnabled()) return res.status(404).send("Not found");
    const authorizationCode = req.query.code;
    try {
      await getTokens(authorizationCode);
      res.send('Authorization successful! Tokens retrieved.');
    } catch (error) {
      console.error('Error in authorization callback:', error);
      res.status(500).send('Error during authorization process.');
    }
};


const files = async (req, res) => {
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
  
    try {
      const response = await drive.files.list({
        q: `'${destinationFolderId}' in parents`,
        fields: 'files(id, name)',
      });
  
      const files = response.data.files;
      res.status(200).json({ files });
    } catch (error) {
      console.error('Error retrieving files:', error);
      res.status(500).json({ error: 'Failed to retrieve files' });
    }
};

// Security: the school's Drive account has full "drive" scope, so the server
// must only touch files that are assignments in our database, and only the
// teacher who uploaded one may delete it (checked BEFORE Drive is called).
const fileDelete = async (req, res, next) => {
  const fileId = req.params.fileId;
  const { id } = req.user;

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    const own = await Assignment.findOne({ where: { teacherId: id, fileData: fileId }, raw: true });
    if (!own) throw new AppError("Assignment not found", 404);
    await drive.files.delete({ fileId });
    await deleteAssignment(id, fileId);

    console.log('Assignment deleted successfully.');
    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    // res.status(500).json({ error: 'Failed to delete file' });
    next(error);
  }

};

const fileDownload = async (req, res, next) => {
    const fileId = req.params.fileId;
  
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
  
    try {
        // Only assignment files; a pupil only their own class's.
        const assignment = await Assignment.findOne({ where: { fileData: fileId }, raw: true });
        if (!assignment) throw new AppError("File not found", 404);
        if (req.user?.userRole === "STU") {
          const studentClass = await getStudentClass(req.user.id);
          if (String(studentClass?.[0]?.class ?? "") !== String(assignment.class ?? "")) throw new AppError("File not found", 404);
        }
        const metadata = await drive.files.get({
            fileId: fileId,
            fields: 'name',
        });
    
        const filename = metadata.data.name;
        console.log(filename)

      const response = await drive.files.get(
        { fileId: fileId, fields: 'name', alt: 'media' },
        { responseType: 'stream' }
      );
  
      res.set({
        'Content-Type': response.headers['content-type'],
        'Content-Length': response.headers['content-length'],
        'Content-Disposition': `attachment; filename="${filename}"`,
      });

      response.data
        .on('end', () => {
          console.log('File download completed.');
        })
        .on('error', (err) => {
          console.error('Error downloading file:', err);
          // res.status(500).json({ error: 'Failed to download file' });
          throw new Error("Failed to download file");
        })
        .pipe(res);
    } catch (error) {
      console.error('Error retrieving file:', error);
      // res.status(500).json({ error: 'Failed to retrieve file' });
      next(error)
    }
}

const redirectToAuth = (req, res) => {
    if (!driveSetupEnabled()) return res.status(404).send("Not found");
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
  
    res.redirect(authUrl);
};

const uploadFile =  async (req, res, next) => {
    const file = req.file;
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    // The teacher comes from the token, never the form (anyone could post as anyone).
    const fileData = { ...req.body, teacherId: req.user.id };
    if (!file) return next(new AppError("Choose a file to upload", 400));

    const fileMetadata = {
      name: file?.originalname,
      parents: [destinationFolderId]
    };
  
    const media = {
      mimeType: file?.mimetype,
      body: createReadableStream(file?.buffer),
    };
  
    try {
      const response = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
      });

      await uploadFileData(fileData, file.originalname, response?.data?.id);
  
      res.status(200).send("File uploaded");
    } catch (error) {
      console.error('Error uploading file:', error);
      // res.status(500).json({ error: 'Failed to upload file' });
      next(error)
    }
};

const fetchAssignment = async (req, res, next) => {
  const { userRole, id } = req.user;
  console.log(userRole)
  let data;
  try {
    
    if(userRole === "STAFF"){
      data = await getAssignmentTeacher(id);
    }else{
      const studentClass = await getStudentClass(id);
      data = await getAssignmentStudent(studentClass[0].class);
    }

    res.status(200).json(data)

  } catch (error) {
    console.log(error)
    next(error)
  }
}


export {
    upload,
    authCallback,
    files,
    fileDownload,
    redirectToAuth,
    uploadFile,
    fetchAssignment,
    fileDelete
}