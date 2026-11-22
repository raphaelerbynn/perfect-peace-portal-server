import { classes } from "../services/classes.js";


const fetchClass = async (req, res, next) => {
    try {
        // Office Class Teacher logins: only their assigned classes (pickers).
        // Portal (STAFF) tokens have no category and keep the full list.
        // ?scope=all: every class, for the read-only Classes page list
        // (writes stay limited to their own class by the services).
        const data = await classes(req.query?.scope === "all" ? null : req.user);
        // console.log(data)
        res.json(data);
    } catch (error) {
        next(error)
    }
}


export {
    fetchClass
}
