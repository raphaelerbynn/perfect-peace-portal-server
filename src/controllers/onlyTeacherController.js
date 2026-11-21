import { classes } from "../services/classes.js";


const fetchClass = async (req, res, next) => {
    try {
        // Office Class Teacher logins: only their assigned classes. Portal
        // (STAFF) tokens have no category and keep the full list.
        const data = await classes(req.user);
        // console.log(data)
        res.json(data);
    } catch (error) {
        next(error)
    }
}


export {
    fetchClass
}
